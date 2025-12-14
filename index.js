import 'dotenv/config';
import fetch from "node-fetch";
import express from "express";
import pkg from "pg";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

// ===== ENV =====
const {
  DISCORD_TOKEN,
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
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: ["CHANNEL"]
});

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
