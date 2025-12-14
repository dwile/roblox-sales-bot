# Roblox Group Sales AI Bot

## Features
- DM-only Discord notifications
- Multi-group support
- Hourly/daily/weekly/monthly summaries
- Charts in Discord
- AI sales prediction
- Upload-time optimization
- Web dashboard API
- Docker + 24/7 hosting ready

## Setup
1. Create a Discord bot and copy token
2. Create PostgreSQL (Railway recommended)
3. Set env vars:
   - DISCORD_TOKEN
   - DISCORD_CLIENT_ID
   - DISCORD_GUILD_ID
   - OWNER_DISCORD_ID
   - DATABASE_URL
   - GROUP_IDS=10432375,6655396
4. npm install
5. npm start

## Docker
docker build -t roblox-sales-bot .
docker run -d --restart unless-stopped roblox-sales-bot