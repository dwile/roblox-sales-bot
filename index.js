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

/* ================= ENV ================= */
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  OWNER_DISCORD_ID,
  DATABASE_URL,
  GROUP_IDS,
  ALERT_SINGLE_SALE,
  ALERT_DAILY_TOTAL
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DATABASE_URL) {
  console.error("❌ ENV eksik. DISCORD_TOKEN / DISCORD_CLIENT_ID / DATABASE_URL gerekli");
  process.exit(1);
}

/* ================= CONST ================= */
const GROUPS = (GROUP_IDS || "")
  .split(",")
  .filter(Boolean)
  .map(x => Number(x.trim()));

const CHECK_INTERVAL = 60 * 1000;
const SINGLE_ALERT = Number(ALERT_SINGLE_SALE || 0);
const DAILY_ALERT = Number(ALERT_DAILY_TOTAL || 0);

/* ================= DB ================= */
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

/* ================= DISCORD CLIENT ================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: ["CHANNEL"]
});

/* ================= SLASH COMMANDS ================= */
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

// 🔥 Global register (ilk sefer 1–2 dk gecikebilir)
await rest.put(
  Routes.applicationCommands(DISCORD_CLIENT_ID),
  { body: commands }
);
console.log("✅ Slash commands registered");

/* ================= INTERACTIONS ================= */
client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;

    // totals
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

    // AI prediction
    if (name === "sales_predict") {
      const r = await db.query(`
        SELECT DATE(created) d, SUM(robux) r
        FROM sales
        WHERE created >= NOW() - INTERVAL '7 days'
        GROUP BY d ORDER BY d
      `);

      const values = r.rows.map(x => x.r);
      const last = values.at(-1) || 0;

      let w = 0, t = 0;
      values.forEach((v, i) => {
        const weight = i + 1;
        w += weight;
        t += v * weight;
      });

      const weighted = t / Math.max(w, 1);
      const prediction = Math.round(weighted * 0.7 + last * 0.3);

      return interaction.reply(`🤖 **AI Prediction:** ~${prediction} Robux`);
    }

    // charts
    if (name === "sales_chart") return sendChart(interaction);
    if (name === "group_chart") {
      const gid = Number(interaction.options.getString("group"));
      return sendChart(interaction, gid);
    }
  } catch (err) {
    console.error("❌ Interaction error", err);
    if (!interaction.replied) {
      interaction.reply("⚠️ Something went wrong");
    }
  }
});

/* ================= CHART ================= */
async function sendChart(interaction, groupId = null) {
  const q = groupId
    ? `SELECT DATE(created) d, SUM(robux) r FROM sales
       WHERE group_id=$1 AND created >= NOW()-INTERVAL '7 days'
       GROUP BY d ORDER BY d`
    : `SELECT DATE(created) d, SUM(robux) r FROM sales
       WHERE created >= NOW()-INTERVAL '7 days'
       GROUP BY d ORDER BY d`;

  const r = groupId ? await db.query(q, [groupId]) : await db.query(q);

  const labels = r.rows.map(x => x.d.toISOString().slice(0, 10));
  const data = r.rows.map(x => x.r);

  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(
    JSON.stringify({
      type: "line",
      data: {
        labels,
        datasets: [{ label: "Robux", data }]
      }
    })
  )}`;

  await interaction.reply(chartUrl);
}

/* ================= ROBLOX ================= */
async function pollGroup(groupId) {
  try {
    const url = `https://economy.roblox.com/v2/groups/${groupId}/transactions?limit=10&sortOrder=Desc&transactionType=Sale`;
    const r = await fetch(url, {
  headers: {
    Cookie: `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`,
    "User-Agent": "Mozilla/5.0"
  }
});
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

      // 🔔 single sale alert
      if (OWNER_DISCORD_ID && sale.currency.amount >= SINGLE_ALERT) {
        const user = await client.users.fetch(OWNER_DISCORD_ID);
        await user.send(
          `🔥 **BIG SALE:** ${sale.details.name} → ${sale.currency.amount} Robux`
        );
      }
    }

    // 🔔 daily alert
    if (OWNER_DISCORD_ID && DAILY_ALERT > 0) {
      const r2 = await db.query(`
        SELECT COALESCE(SUM(robux),0) total
        FROM sales
        WHERE created >= CURRENT_DATE
      `);
      if (r2.rows[0].total >= DAILY_ALERT) {
        const user = await client.users.fetch(OWNER_DISCORD_ID);
        await user.send(`📈 **Daily target reached:** ${r2.rows[0].total} Robux`);
      }
    }
  } catch (e) {
    console.error("❌ Roblox poll error", e);
  }
}

/* ================= DASHBOARD API ================= */
const app = express();
app.get("/dashboard", async (_, res) => {
  const r = await db.query(
    "SELECT * FROM sales ORDER BY created DESC LIMIT 100"
  );
  res.json(r.rows);
});
app.listen(3000);

/* ================= START ================= */
client.once("clientReady", () => {
  console.log("✅ Bot Online");
  if (GROUPS.length) {
    setInterval(() => GROUPS.forEach(pollGroup), CHECK_INTERVAL);
  }
});

process.on("unhandledRejection", err => {
  console.error("🔥 UNHANDLED", err);
});

client.login(DISCORD_TOKEN);
