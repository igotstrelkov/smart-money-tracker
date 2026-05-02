# Polymarket Smart-Money Tracker

Monitors on-chain activity from successful traders on Polymarket and sends Telegram alerts.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create a Telegram bot:
   - Open Telegram and message [@BotFather](https://t.me/BotFather)
   - Send `/newbot` and follow the prompts
   - Copy the bot token you receive

3. Get your chat ID:
   - Send any message to your new bot in Telegram
   - Run:
     ```bash
     curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
     ```
   - Find `"chat":{"id":` in the response — that number is your chat ID

4. Configure environment:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` with the values from steps 2-3.

## Run locally

```bash
npx tsx src/index.ts
```
