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

## Deployment

```bash
git clone <repo>
cd smart-money-tracker
cp .env.example .env  # edit with real values
npm install
mkdir -p data logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # follow the printed command
```

## Operations

```bash
pm2 logs smart-money-tracker     # tail logs
pm2 restart smart-money-tracker  # restart after slate.json edit
pm2 status                       # health check
```

## Shadow PnL evaluation

Run on demand to check hypothetical copy-trade performance:

```bash
npx tsx src/evaluate-shadow.ts
```
