import 'dotenv/config';
import fetch from "node-fetch";
import express from "express";
import pkg from "pg";
import { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } from "discord.js";

// ===== ENV =====
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  OWNER_DISCORD_ID,
  DATABASE_URL,
  GROUP_IDS
} = process.env;

const GROUPS = (GROUP_IDS || "10432375,6655396").split(",").map(x => Number(x.trim()));
const CHECK_INTERVAL = 60 * 1000;

// ===== DB =====
const { Pool } = pkg;
const db = new Pool({ connectionString: DATABASE_URL });

await db.query(`
CREATE TABLE IF NOT EXISTS sales (
  id_hash TEXT PRIMARY KEY,
  group_id BIGINT,
  item TEXT,
  buyer TEXT,
  buyer_id BIGINT,
  robux INT,
  created TIMESTAMP
);
`);

// ===== DISCORD =====
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Slash commands
const commands = [
  { name: "sales_today", description: "Show today's Robux earned" },
  { name: "sales_week", description: "Show this week's Robux earned" },
  { name: "sales_month", description: "Show this month's Robux earned" },
  { name: "sales_chart", description: "Overall sales chart (7 days)" },
  { name: "group_chart", description: "Per-group chart", options: [{ name: "group", type: 3, required: true }] },
  { name: "sales_predict", description: "AI prediction for next 24h sales" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
await rest.put(
  Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
  { body: commands }
);

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "sales_chart") {
    return sendChart(interaction);
  }

  if (interaction.commandName === "group_chart") {
    const gid = Number(interaction.options.getString("group"));
    return sendChart(interaction, gid);
  }

  if (interaction.commandName === "sales_predict") {
    const r = await db.query(`
      SELECT DATE(created) d, SUM(robux) r
      FROM sales
      WHERE created >= NOW() - INTERVAL '7 days'
      GROUP BY d ORDER BY d
    `);
    const values = r.rows.map(x => x.r);
    let weightSum = 0, total = 0;
    values.forEach((v,i)=>{ const w=i+1; weightSum+=w; total+=v*w; });
    const prediction = Math.round(total / Math.max(weightSum,1));
    return interaction.reply(`🤖 **AI Prediction:** ~${prediction} Robux expected in the next 24 hours`);
  }

  let interval = "day";
  if (interaction.commandName === "sales_week") interval = "week";
  if (interaction.commandName === "sales_month") interval = "month";

  const res = await db.query(
    `SELECT SUM(robux) as total FROM sales WHERE created >= NOW() - INTERVAL '1 ${interval}'`
  );
  await interaction.reply(`💰 **${interval.toUpperCase()} TOTAL:** ${res.rows[0].total || 0} Robux`);
});

async function sendChart(interaction, groupId=null) {
  const width = 900, height = 420;
  const chartCanvas = new ChartJSNodeCanvas({ width, height });

  const q = groupId
    ? `SELECT DATE(created) d, SUM(robux) r FROM sales WHERE group_id=$1 AND created >= NOW() - INTERVAL '7 days' GROUP BY d ORDER BY d`
    : `SELECT DATE(created) d, SUM(robux) r FROM sales WHERE created >= NOW() - INTERVAL '7 days' GROUP BY d ORDER BY d`;

  const data = groupId ? await db.query(q, [groupId]) : await db.query(q);

  const labels = data.rows.map(x => x.d.toISOString().slice(0,10));
  const values = data.rows.map(x => x.r);

  const image = await chartCanvas.renderToBuffer({
    type: "line",
    data: { labels, datasets: [{ label: "Robux", data: values }] }
  });

  await interaction.reply({ files: [{ attachment: image, name: "sales.png" }] });
}

// ===== ROBLOX =====
async function getAvatar(userId) {
  const r = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`);
  const j = await r.json();
  return j.data?.[0]?.imageUrl;
}

async function pollGroup(groupId) {
  const url = `https://economy.roblox.com/v2/groups/${groupId}/transactions?limit=10&sortOrder=Desc&transactionType=Sale`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.data) return;

  for (const sale of j.data.reverse()) {
    if (sale.details?.type !== "Asset") continue;
    const exists = await db.query("SELECT 1 FROM sales WHERE id_hash=$1", [sale.idHash]);
    if (exists.rowCount) continue;

    await db.query(
      "INSERT INTO sales VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [sale.idHash, groupId, sale.details.name, sale.agent.name, sale.agent.id, sale.currency.amount, sale.created]
    );

    const avatar = await getAvatar(sale.agent.id);
    const user = await client.users.fetch(OWNER_DISCORD_ID);

    const embed = new EmbedBuilder()
      .setTitle("👕 New Clothing Sale")
      .addFields(
        { name: "Item", value: sale.details.name, inline: true },
        { name: "Buyer", value: sale.agent.name, inline: true },
        { name: "Price", value: `${sale.currency.amount} Robux`, inline: true }
      )
      .setThumbnail(avatar)
      .setTimestamp(new Date(sale.created));

    await user.send({ embeds: [embed] });
  }
}

// ===== DASHBOARD API =====
const app = express();
app.get("/dashboard", async (_, res) => {
  const r = await db.query(`
    SELECT group_id, DATE(created) d, SUM(robux) r
    FROM sales
    GROUP BY group_id, d ORDER BY d
  `);
  res.json(r.rows);
});
app.listen(3000);

// ===== START =====
client.once("ready", () => {
  console.log("✅ Bot Online");
  setInterval(() => GROUPS.forEach(pollGroup), CHECK_INTERVAL);
});
client.login(DISCORD_TOKEN);