import "dotenv/config";
import fetch from "node-fetch";
import express from "express";
import pkg from "pg";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder
} from "discord.js";

/* ================= ENV ================= */
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  OWNER_DISCORD_ID,
  DATABASE_URL,
  GROUP_IDS,
  ROBLOX_COOKIE,
  ALERT_SINGLE_SALE = 0
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DATABASE_URL || !ROBLOX_COOKIE) {
  console.error("❌ Missing ENV variables");
  process.exit(1);
}

/* ================= CONST ================= */
const GROUPS = (GROUP_IDS || "")
  .split(",")
  .map(x => Number(x.trim()))
  .filter(Boolean);

const CHECK_INTERVAL = 60 * 1000;
const ANALYTICS_INTERVAL = 60 * 60 * 1000;

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
)`);

await db.query(`
CREATE TABLE IF NOT EXISTS analytics_daily (
  date DATE PRIMARY KEY,
  total INT,
  avg7 FLOAT,
  trend FLOAT,
  volatility FLOAT
)`);

/* ================= DISCORD ================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: ["CHANNEL"]
});

/* ================= SLASH COMMANDS ================= */
const commands = [
  { name: "sales_today", description: "Today's Robux earned" },
  { name: "sales_week", description: "Last 7 days Robux" },
  { name: "sales_chart", description: "Sales chart (7 days)" },
  { name: "sales_predict", description: "AI forecast (24h)" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });

/* ================= INTERACTIONS ================= */
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "sales_today") {
    const r = await db.query(`
      SELECT COALESCE(SUM(robux),0) total
      FROM sales WHERE created >= CURRENT_DATE
    `);
    return interaction.reply(`💰 **Today:** ${r.rows[0].total} Robux`);
  }

  if (interaction.commandName === "sales_week") {
    const r = await db.query(`
      SELECT COALESCE(SUM(robux),0) total
      FROM sales WHERE created >= NOW()-INTERVAL '7 days'
    `);
    return interaction.reply(`📊 **Last 7 Days:** ${r.rows[0].total} Robux`);
  }

  if (interaction.commandName === "sales_predict") {
    const r = await db.query(`
      SELECT * FROM analytics_daily
      ORDER BY date DESC LIMIT 1
    `);

    if (!r.rowCount) {
      return interaction.reply("📉 Not enough data yet.");
    }

    const d = r.rows[0];
    const prediction = Math.max(Math.round(d.avg7 * (1 + d.trend)), 0);

    return interaction.reply(
      `🤖 **AI Forecast (24h)**\n` +
      `Expected: **${prediction} Robux**\n` +
      `Trend: ${d.trend > 0 ? "📈 Up" : "📉 Down"}`
    );
  }

  if (interaction.commandName === "sales_chart") {
    const r = await db.query(`
      SELECT DATE(created) d, SUM(robux) r
      FROM sales
      WHERE created >= NOW()-INTERVAL '7 days'
      GROUP BY d ORDER BY d
    `);

    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(
      JSON.stringify({
        type: "line",
        data: {
          labels: r.rows.map(x => x.d.toISOString().slice(0,10)),
          datasets: [{ label: "Robux", data: r.rows.map(x => x.r) }]
        }
      })
    )}`;

    return interaction.reply(chartUrl);
  }
});

/* ================= ROBLOX POLLER ================= */
async function pollGroup(groupId) {
  try {
    const r = await fetch(
      `https://economy.roblox.com/v2/groups/${groupId}/transactions?limit=10&sortOrder=Desc&transactionType=Sale`,
      {
        headers: {
          Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}`,
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const j = await r.json();
    if (!j.data) return;

    for (const sale of j.data.reverse()) {
      if (sale.details?.type !== "Asset") continue;

      try {
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
      } catch {
        continue;
      }

      if (OWNER_DISCORD_ID && sale.currency.amount >= ALERT_SINGLE_SALE) {
        const user = await client.users.fetch(OWNER_DISCORD_ID);

        const embed = new EmbedBuilder()
          .setTitle("🛒 New Sale")
          .addFields(
            { name: "Item", value: sale.details.name, inline: true },
            { name: "Robux", value: `${sale.currency.amount}`, inline: true },
            { name: "Group ID", value: String(groupId), inline: true }
          )
          .setTimestamp();

        await user.send({ embeds: [embed] });
      }
    }
  } catch (e) {
    console.error("Poll error", e);
  }
}

/* ================= ANALYTICS ================= */
async function runAnalytics() {
  const r = await db.query(`
    SELECT DATE(created) d, SUM(robux) r
    FROM sales
    GROUP BY d ORDER BY d
  `);

  if (r.rows.length < 7) return;

  const values = r.rows.map(x => x.r);
  const today = r.rows.at(-1).d;
  const total = values.at(-1);
  const avg7 = values.slice(-7).reduce((a,b)=>a+b,0)/7;
  const trend = (total - avg7) / Math.max(avg7,1);

  const variance = values.slice(-7)
    .reduce((a,b)=>a+Math.pow(b-avg7,2),0)/7;
  const volatility = Math.sqrt(variance);

  await db.query(`
    INSERT INTO analytics_daily
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (date)
    DO UPDATE SET total=$2, avg7=$3, trend=$4, volatility=$5
  `,[today,total,avg7,trend,volatility]);
}

/* ================= DASHBOARD ================= */
const app = express();

app.get("/dashboard", async (_, res) => {
  const today = await db.query(`
    SELECT COALESCE(SUM(robux),0) r, COUNT(*) c
    FROM sales WHERE created >= CURRENT_DATE
  `);

  res.send(`
<!doctype html>
<html>
<head>
<title>Roblox Sales Dashboard</title>
<style>
body{background:#0f172a;color:#e5e7eb;font-family:Arial;padding:30px}
.card{background:#111827;padding:20px;border-radius:12px;margin-bottom:10px}
</style>
</head>
<body>
<h1>📊 Roblox Sales</h1>
<div class="card">Today Robux: <b>${today.rows[0].r}</b></div>
<div class="card">Sales Count: <b>${today.rows[0].c}</b></div>
</body>
</html>
`);
});

app.listen(process.env.PORT || 3000);

/* ================= START ================= */
client.once("clientReady", () => {
  console.log("✅ Bot Online");
  setInterval(() => GROUPS.forEach(pollGroup), CHECK_INTERVAL);
  setInterval(runAnalytics, ANALYTICS_INTERVAL);
});

client.login(DISCORD_TOKEN);
