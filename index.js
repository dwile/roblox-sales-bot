import "dotenv/config";
import fetch from "node-fetch";
import express from "express";
import pkg from "pg";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes
} from "discord.js";

// ===== ENV =====
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  OWNER_DISCORD_ID,
  DATABASE_URL,
  GROUP_IDS
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error("❌ DISCORD_TOKEN or DISCORD_CLIENT_ID missing");
}

const GROUPS = (GROUP_IDS || "10432375,6655396")
  .split(",")
  .map(x => Number(x.trim()));

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

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ],
  partials: ["CHANNEL"]
});

// ===== SLASH COMMANDS (GLOBAL) =====
const commands = [
  { name: "sales_today", description: "Today's Robux earned" },
  { name: "sales_week", description: "This week's Robux earned" },
  { name: "sales_month", description: "This month's Robux earned" },
  { name: "sales_chart", description: "Sales chart (last 7 days)" },
  {
  name: "group_chart",
  description: "Group sales chart (last 7 days)",
  options: [
    {
      name: "group",
      description: "Roblox Group ID",
      type: 3,
      required: true
    }
  ]
},
  { name: "sales_predict", description: "AI prediction for next 24h" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

await rest.put(
  Routes.applicationCommands(DISCORD_CLIENT_ID),
  { body: commands }
);

console.log("✅ Global slash commands registered");

// ===== INTERACTIONS =====
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  // ---- totals ----
  if (["sales_today", "sales_week", "sales_month"].includes(name)) {
    let interval = "day";
    if (name === "sales_week") interval = "week";
    if (name === "sales_month") interval = "month";

    const r = await db.query(
      `SELECT COALESCE(SUM(robux),0) total
       FROM sales
       WHERE created >= NOW() - INTERVAL '1 ${interval}'`
    );

    return interaction.reply(
      `💰 **${interval.toUpperCase()} TOTAL:** ${r.rows[0].total} Robux`
    );
  }

  // ---- AI prediction ----
  if (name === "sales_predict") {
    const r = await db.query(`
      SELECT DATE(created) d, SUM(robux) r
      FROM sales
      WHERE created >= NOW() - INTERVAL '7 days'
      GROUP BY d ORDER BY d
    `);

    const values = r.rows.map(x => x.r);
    let w = 0, t = 0;
    values.forEach((v, i) => {
      const weight = i + 1;
      w += weight;
      t += v * weight;
    });

    const prediction = Math.round(t / Math.max(w, 1));
    return interaction.reply(
      `🤖 **AI Prediction:** ~${prediction} Robux in next 24h`
    );
  }

  // ---- charts ----
  if (name === "sales_chart") return sendChart(interaction);
  if (name === "group_chart") {
    const gid = Number(interaction.options.getString("group"));
    return sendChart(interaction, gid);
  }
});

// ===== QUICKCHART =====
async function sendChart(interaction, groupId = null) {
  const q = groupId
    ? `SELECT DATE(created) d, SUM(robux) r
       FROM sales
       WHERE group_id=$1 AND created >= NOW()-INTERVAL '7 days'
       GROUP BY d ORDER BY d`
    : `SELECT DATE(created) d, SUM(robux) r
       FROM sales
       WHERE created >= NOW()-INTERVAL '7 days'
       GROUP BY d ORDER BY d`;

  const r = groupId ? await db.query(q, [groupId]) : await db.query(q);

  const labels = r.rows.map(x => x.d.toISOString().slice(0, 10));
  const data = r.rows.map(x => x.r);

  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify({
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Robux", data }]
    }
  }))}`;

  await interaction.reply({ content: chartUrl });
}

// ===== ROBLOX =====
async function getAvatar(userId) {
  const r = await fetch(
    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`
  );
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

    const exists = await db.query(
      "SELECT 1 FROM sales WHERE id_hash=$1",
      [sale.idHash]
    );
    if (exists.rowCount) continue;

    await db.query(
      "INSERT INTO sales VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        sale.idHash,
        groupId,
        sale.details.name,
        sale.agent.name,
        sale.agent.id,
        sale.currency.amount,
        sale.created
      ]
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

// ===== DASHBOARD =====
const app = express();
app.get("/dashboard", async (_, res) => {
  const r = await db.query(`
    SELECT group_id, DATE(created) d, SUM(robux) r
    FROM sales
    GROUP BY group_id, d
    ORDER BY d
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
