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
  console.error("❌ Missing ENV");
  process.exit(1);
}

/* ================= CONST ================= */
const GROUPS = (GROUP_IDS || "")
  .split(",")
  .filter(Boolean)
  .map(x => Number(x.trim()));

const CHECK_INTERVAL = 60 * 1000;
const ANALYTICS_INTERVAL = 60 * 60 * 1000;

/* ================= SAFE GUARDS ================= */
const pollingGroups = new Set();
let analyticsRunning = false;

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

await db.query(`
CREATE TABLE IF NOT EXISTS analytics_daily (
  date DATE PRIMARY KEY,
  total INT,
  avg7 FLOAT,
  avg14 FLOAT,
  trend FLOAT,
  volatility FLOAT
);
`);

await db.query(`
CREATE TABLE IF NOT EXISTS analytics_items (
  item TEXT PRIMARY KEY,
  total INT,
  last7 INT,
  trend FLOAT
);
`);

await db.query(`
CREATE TABLE IF NOT EXISTS anomalies (
  date DATE,
  reason TEXT,
  value INT
);
`);

/* ================= DISCORD ================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: ["CHANNEL"]
});

/* ================= SLASH COMMANDS ================= */
const commands = [
  { name: "sales_today", description: "Today's Robux earned" },
  { name: "sales_week", description: "This week's Robux earned" },
  { name: "sales_month", description: "This month's Robux earned" },
  { name: "sales_chart", description: "Sales chart (7 days)" },
  { name: "sales_predict", description: "AI forecast (24h)" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });

/* ================= INTERACTIONS ================= */
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;

  if (["sales_today", "sales_week", "sales_month"].includes(name)) {
    const interval =
      name === "sales_week" ? "7 days" :
      name === "sales_month" ? "30 days" : "1 day";

    const r = await db.query(
      `SELECT COALESCE(SUM(robux),0) total
       FROM sales WHERE created >= NOW() - INTERVAL '${interval}'`
    );

    return interaction.reply(`💰 **TOTAL:** ${r.rows[0].total} Robux`);
  }

  if (name === "sales_predict") {
    const r = await db.query(`
      SELECT total, avg7, trend, volatility
      FROM analytics_daily
      ORDER BY date DESC LIMIT 1
    `);

    if (!r.rowCount) {
      return interaction.reply("📉 Not enough data yet");
    }

    const d = r.rows[0];
    const prediction = Math.max(
      Math.round(d.avg7 * (1 + d.trend)),
      0
    );

    const confidence =
      d.volatility < d.avg7 * 0.3 ? "High" :
      d.volatility < d.avg7 * 0.6 ? "Medium" : "Low";

    return interaction.reply(
      `🤖 **AI Forecast (24h)**\n` +
      `~${prediction} Robux\n` +
      `Trend: ${d.trend > 0 ? "📈 Up" : "📉 Down"}\n` +
      `Confidence: ${confidence}`
    );
  }

  if (name === "sales_chart") {
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

/* ================= ROBLOX POLL ================= */
async function pollGroup(groupId) {
  if (pollingGroups.has(groupId)) return;
  pollingGroups.add(groupId);

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
            { name: "Price", value: `${sale.currency.amount} Robux`, inline: true },
            { name: "Group ID", value: String(groupId), inline: true }
          )
          .setTimestamp();

        await user.send({ embeds: [embed] });
      }
    }
  } catch (e) {
    console.error("Poll error", e);
  } finally {
    pollingGroups.delete(groupId);
  }
}

/* ================= ANALYTICS ENGINE ================= */
async function runAnalytics() {
  if (analyticsRunning) return;
  analyticsRunning = true;

  try {
    const r = await db.query(`
      SELECT DATE(created) d, SUM(robux) r
      FROM sales
      GROUP BY d ORDER BY d
    `);

    const values = r.rows.map(x => x.r);
    if (values.length < 7) return;

    const today = r.rows.at(-1).d;
    const total = values.at(-1);
    const avg7 = values.slice(-7).reduce((a,b)=>a+b,0)/7;
    const avg14 = values.slice(-14).reduce((a,b)=>a+b,0)/Math.min(14,values.length);

    const trend = (total - avg7) / Math.max(avg7,1);
    const variance = values.slice(-7).reduce((a,b)=>a+Math.pow(b-avg7,2),0)/7;
    const volatility = Math.sqrt(variance);

    await db.query(`
      INSERT INTO analytics_daily
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (date) DO UPDATE
      SET total=$2, avg7=$3, avg14=$4, trend=$5, volatility=$6
    `,[today,total,avg7,avg14,trend,volatility]);

    if (total > avg7 + 2 * volatility) {
      await db.query(
        "INSERT INTO anomalies VALUES ($1,$2,$3)",
        [today,"Spike detected",total]
      );
    }
  } catch (e) {
    console.error("Analytics error", e);
  } finally {
    analyticsRunning = false;
  }
}

/* ================= DASHBOARD ================= */
const app = express();

app.get("/dashboard", async (_, res) => {
  const stats = await db.query(
    "SELECT * FROM analytics_daily ORDER BY date DESC LIMIT 1"
  );

  const a = stats.rows[0] || {};

  res.send(`
<!doctype html>
<html>
<head>
<title>Roblox Sales Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body {
  background:#0f172a;
  color:#e5e7eb;
  font-family:Inter,Arial;
  padding:30px;
}
h1 { margin-bottom:20px }
.cards {
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
  gap:15px;
}
.card {
  background:#111827;
  padding:20px;
  border-radius:12px;
  box-shadow:0 10px 30px rgba(0,0,0,.3);
}
.card h3 {
  font-size:14px;
  color:#9ca3af;
  margin-bottom:8px;
}
.card p {
  font-size:26px;
  font-weight:bold;
}
</style>
</head>

<body>
<h1>📊 Roblox Sales Analytics</h1>

<div class="cards">
  <div class="card">
    <h3>Today Robux</h3>
    <p>${a.total_robux || 0}</p>
  </div>
  <div class="card">
    <h3>Sales Count</h3>
    <p>${a.sales_count || 0}</p>
  </div>
  <div class="card">
    <h3>Top Item</h3>
    <p>${a.top_item || "-"}</p>
  </div>
</div>

</body>
</html>
`);
});

app.listen(3000);

/* ================= START ================= */
client.once("clientReady", () => {
  console.log("✅ Bot Online");
  setInterval(() => GROUPS.forEach(pollGroup), CHECK_INTERVAL);
  setInterval(runAnalytics, ANALYTICS_INTERVAL);
});

client.login(DISCORD_TOKEN);
