import "dotenv/config";
import fetch from "node-fetch";
import express from "express";
import pkg from "pg";
import {
  Client,
  GatewayIntentBits,
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

/* ================= SAFE GUARDS ================= */
const pollingGroups = new Set();
const processingSales = new Set();

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
  {
    name: "group_chart",
    description: "Group sales chart (7 days)",
    options: [
      {
        name: "group",
        description: "Roblox Group ID",
        type: 3,
        required: true
      }
    ]
  },
  { name: "sales_predict", description: "AI prediction (24h)" }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
console.log("✅ Slash commands registered");

/* ================= INTERACTIONS ================= */
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const name = interaction.commandName;

  if (["sales_today", "sales_week", "sales_month"].includes(name)) {
    const interval =
      name === "sales_week" ? "week" :
      name === "sales_month" ? "month" : "day";

    const r = await db.query(`
      SELECT COALESCE(SUM(robux),0) total
      FROM sales
      WHERE created >= NOW() - INTERVAL '1 ${interval}'
    `);

    return interaction.reply(`💰 **${interval.toUpperCase()} TOTAL:** ${r.rows[0].total} Robux`);
  }

  if (name === "sales_predict") {
    const r = await db.query(`
      SELECT DATE(created) d, SUM(robux) r
      FROM sales
      WHERE created >= NOW()-INTERVAL '14 days'
      GROUP BY d ORDER BY d
    `);

    const values = r.rows.map(x => x.r);
    const avg7 = values.slice(-7).reduce((a,b)=>a+b,0)/7 || 0;
    const last = values.at(-1) || 0;
    const trend = last >= avg7 ? "📈 Uptrend" : "📉 Slow";

    const prediction = Math.round(avg7 * 1.15);
    return interaction.reply(`🤖 **AI Forecast (24h)**\n~${prediction} Robux\n${trend}`);
  }

  if (name === "sales_chart") return sendChart(interaction);
  if (name === "group_chart") {
    const gid = Number(interaction.options.getString("group"));
    return sendChart(interaction, gid);
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

  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(
    JSON.stringify({
      type: "line",
      data: {
        labels: r.rows.map(x => x.d.toISOString().slice(0,10)),
        datasets: [{ label: "Robux", data: r.rows.map(x => x.r) }]
      }
    })
  )}`;

  await interaction.reply(chartUrl);
}

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
      if (processingSales.has(sale.idHash)) continue;
      processingSales.add(sale.idHash);

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
      } catch (e) {
        if (e.code !== "23505") console.error(e);
      }

      if (OWNER_DISCORD_ID && sale.currency.amount >= ALERT_SINGLE_SALE) {
        const user = await client.users.fetch(OWNER_DISCORD_ID);
        await user.send(`🔥 **SALE:** ${sale.details.name} → ${sale.currency.amount} Robux`);
      }

      setTimeout(() => processingSales.delete(sale.idHash), 60_000);
    }
  } catch (e) {
    console.error("❌ Poll error", e);
  } finally {
    pollingGroups.delete(groupId);
  }
}

/* ================= DASHBOARD ================= */
const app = express();

app.get("/api/stats", async (_, res) => {
  const today = await db.query("SELECT COALESCE(SUM(robux),0) r FROM sales WHERE created >= CURRENT_DATE");
  const week = await db.query("SELECT COALESCE(SUM(robux),0) r FROM sales WHERE created >= NOW()-INTERVAL '7 days'");
  const top = await db.query(`
    SELECT item, SUM(robux) r FROM sales
    GROUP BY item ORDER BY r DESC LIMIT 1
  `);

  res.json({
    today: today.rows[0].r,
    week: week.rows[0].r,
    topItem: top.rows[0] || null
  });
});

app.get("/api/chart", async (_, res) => {
  const r = await db.query(`
    SELECT DATE(created) d, SUM(robux) r
    FROM sales WHERE created >= NOW()-INTERVAL '7 days'
    GROUP BY d ORDER BY d
  `);

  res.json({
    labels: r.rows.map(x => x.d.toISOString().slice(0,10)),
    data: r.rows.map(x => x.r)
  });
});

app.get("/dashboard", (_, res) => {
  res.send(`
<!doctype html>
<html>
<head>
<title>Roblox Sales</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body{background:#111;color:#eee;font-family:Arial;padding:20px}
.card{background:#222;padding:15px;border-radius:8px;margin-bottom:10px}
</style>
</head>
<body>
<h2>📊 Roblox Sales Dashboard</h2>
<div class="card" id="stats"></div>
<canvas id="chart"></canvas>

<script>
fetch('/api/stats').then(r=>r.json()).then(d=>{
  document.getElementById('stats').innerHTML =
   'Today: <b>'+d.today+'</b> Robux<br>' +
   'Week: <b>'+d.week+'</b> Robux<br>' +
   'Top Item: <b>'+(d.topItem?.item||'-')+'</b>';
});
fetch('/api/chart').then(r=>r.json()).then(c=>{
 new Chart(document.getElementById('chart'),{
  type:'line',
  data:{labels:c.labels,datasets:[{label:'Robux',data:c.data}]}
 });
});
</script>
</body>
</html>
`);
});

app.listen(3000);

/* ================= AUTO REPORTS ================= */
setInterval(async () => {
  if (!OWNER_DISCORD_ID) return;
  const r = await db.query("SELECT COALESCE(SUM(robux),0) r FROM sales WHERE created >= CURRENT_DATE");
  const user = await client.users.fetch(OWNER_DISCORD_ID);
  await user.send(`📊 **Daily Report:** ${r.rows[0].r} Robux`);
}, 24 * 60 * 60 * 1000);

setInterval(async () => {
  if (!OWNER_DISCORD_ID) return;
  const r = await db.query("SELECT COALESCE(SUM(robux),0) r FROM sales WHERE created >= NOW()-INTERVAL '7 days'");
  const user = await client.users.fetch(OWNER_DISCORD_ID);
  await user.send(`📈 **Weekly Report:** ${r.rows[0].r} Robux`);
}, 7 * 24 * 60 * 60 * 1000);

/* ================= START ================= */
client.once("clientReady", () => {
  console.log("✅ Bot Online");
  setInterval(() => GROUPS.forEach(pollGroup), CHECK_INTERVAL);
});

client.login(DISCORD_TOKEN);
