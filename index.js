import "dotenv/config";
import fetch from "node-fetch";
import express from "express";
import cookieParser from "cookie-parser";
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
  DISCORD_CLIENT_SECRET,
  OWNER_DISCORD_ID,
  DATABASE_URL,
  GROUP_IDS,
  ROBLOX_COOKIE,
  BASE_URL,
  ALERT_SINGLE_SALE = 0,
  PORT = 3000
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DATABASE_URL || !ROBLOX_COOKIE || !DISCORD_CLIENT_SECRET || !BASE_URL) {
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

await db.query(`
CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  plan TEXT DEFAULT 'free',
  created TIMESTAMP DEFAULT NOW()
)`);

/* ================= DISCORD BOT ================= */
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

  try {
    if (interaction.commandName === "sales_today") {
      const r = await db.query(`SELECT COALESCE(SUM(robux),0) total FROM sales WHERE created >= CURRENT_DATE`);
      return interaction.reply(`💰 **Today:** ${r.rows[0].total} Robux`);
    }

    if (interaction.commandName === "sales_week") {
      const r = await db.query(`SELECT COALESCE(SUM(robux),0) total FROM sales WHERE created >= NOW()-INTERVAL '7 days'`);
      return interaction.reply(`📊 **Last 7 Days:** ${r.rows[0].total} Robux`);
    }

    if (interaction.commandName === "sales_predict") {
      const r = await db.query(`SELECT * FROM analytics_daily ORDER BY date DESC LIMIT 1`);
      if (!r.rowCount) return interaction.reply("📉 Not enough data yet.");

      const d = r.rows[0];
      const prediction = Math.max(Math.round(d.avg7 * (1 + d.trend)), 0);

      return interaction.reply(
        `🤖 **AI Forecast (24h)**\nExpected: **${prediction} Robux**\nTrend: ${d.trend > 0 ? "📈 Up" : "📉 Down"}`
      );
    }

    if (interaction.commandName === "sales_chart") {
      const r = await db.query(`
        SELECT DATE(created) d, SUM(robux) r
        FROM sales WHERE created >= NOW()-INTERVAL '7 days'
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
  } catch (e) {
    console.error(e);
    if (!interaction.replied) interaction.reply("❌ Error");
  }
});

/* ================= ROBLOX POLLER ================= */
async function pollGroup(groupId) {
  try {
    const r = await fetch(
      `https://economy.roblox.com/v2/groups/${groupId}/transactions?limit=10&sortOrder=Desc&transactionType=Sale`,
      { headers: { Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}`, "User-Agent": "Mozilla/5.0" } }
    );

    const j = await r.json();
    if (!j.data) return;

    for (const sale of j.data.reverse()) {
      if (sale.details?.type !== "Asset") continue;

      try {
        await db.query("INSERT INTO sales VALUES ($1,$2,$3,$4,$5,$6,$7)", [
          sale.idHash,
          groupId,
          sale.details.name,
          sale.agent.name,
          sale.agent.id,
          sale.currency.amount,
          sale.created
        ]);
      } catch { continue; }

      if (OWNER_DISCORD_ID && sale.currency.amount >= ALERT_SINGLE_SALE) {
        const user = await client.users.fetch(OWNER_DISCORD_ID);
        const embed = new EmbedBuilder()
          .setTitle("🛒 New Sale")
          .addFields(
            { name: "Item", value: sale.details.name, inline: true },
            { name: "Robux", value: String(sale.currency.amount), inline: true },
            { name: "Group", value: String(groupId), inline: true }
          )
          .setTimestamp();
        await user.send({ embeds: [embed] });
      }
    }
  } catch (e) {
    console.error("Poll error:", e);
  }
}

/* ================= ANALYTICS ================= */
async function runAnalytics() {
  const r = await db.query(`SELECT DATE(created) d, SUM(robux) r FROM sales GROUP BY d ORDER BY d`);
  if (r.rows.length < 7) return;

  const values = r.rows.map(x => x.r);
  const today = r.rows.at(-1).d;
  const total = values.at(-1);
  const avg7 = values.slice(-7).reduce((a,b)=>a+b,0)/7;
  const trend = (total - avg7) / Math.max(avg7,1);
  const variance = values.slice(-7).reduce((a,b)=>a+Math.pow(b-avg7,2),0)/7;
  const volatility = Math.sqrt(variance);

  await db.query(`
    INSERT INTO analytics_daily VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (date)
    DO UPDATE SET total=$2, avg7=$3, trend=$4, volatility=$5
  `,[today,total,avg7,trend,volatility]);
}

/* ================= DASHBOARD + AUTH ================= */
const app = express();
app.use(cookieParser());

const oauthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE_URL+"/auth/callback")}&response_type=code&scope=identify`;

app.get("/login", (_, res) => res.redirect(oauthUrl));

app.get("/auth/callback", async (req, res) => {
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: BASE_URL+"/auth/callback"
    })
  });

  const token = await tokenRes.json();
  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  const user = await userRes.json();

  await db.query("INSERT INTO users (discord_id) VALUES ($1) ON CONFLICT DO NOTHING", [user.id]);

  res.cookie("uid", user.id);
  res.redirect("/dashboard");
});

app.get("/dashboard", async (req, res) => {
  if (!req.cookies.uid) return res.redirect("/login");

  const today = await db.query(`SELECT COALESCE(SUM(robux),0) r, COUNT(*) c FROM sales WHERE created >= CURRENT_DATE`);

  res.send(`
  <h1>Roblox Sales Dashboard</h1>
  <p>Today Robux: <b>${today.rows[0].r}</b></p>
  <p>Sales Count: <b>${today.rows[0].c}</b></p>
  <a href="/upgrade">Upgrade Pro</a>
  `);
});

app.get("/upgrade", async (req,res)=>{
  await db.query("UPDATE users SET plan='pro' WHERE discord_id=$1",[req.cookies.uid]);
  res.send("✅ Pro plan active");
});

app.get("/admin", async (req,res)=>{
  if(req.cookies.uid!==OWNER_DISCORD_ID) return res.send("Forbidden");
  const u = await db.query("SELECT * FROM users");
  res.send(`<pre>${JSON.stringify(u.rows,null,2)}</pre>`);
});

app.listen(PORT,()=>console.log("🌐 Dashboard running",PORT));

/* ================= START ================= */
client.once("ready", () => {
  console.log("✅ Bot Online");
  setInterval(() => GROUPS.forEach(pollGroup), CHECK_INTERVAL);
  setInterval(runAnalytics, ANALYTICS_INTERVAL);
});

client.login(DISCORD_TOKEN);
