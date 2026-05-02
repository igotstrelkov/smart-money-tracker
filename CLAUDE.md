# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polymarket Smart-Money Tracker — monitors on-chain activity from whale wallets on Polymarket and sends Telegram alerts. Uses polling (30s intervals), not WebSockets. Includes shadow PnL logging to evaluate whether copy-trading the slate would be profitable.

## Stack

- TypeScript, ESM modules, run via `tsx` (no build step)
- Node.js 20+
- Dependencies: `tsx`, `dotenv`, `better-sqlite3` — nothing else unless explicitly required
- SQLite for dedup, market cache, and shadow position tracking
- pm2 for production process management

## Commands

```bash
# Run the app locally
npx tsx src/index.ts

# Production (pm2)
pm2 start ecosystem.config.cjs
pm2 logs smart-money-tracker
pm2 restart smart-money-tracker

# Shadow PnL evaluation (run on demand)
npx tsx src/evaluate-shadow.ts
```

## Architecture

Single-process polling loop. No monorepo, no workspaces.

- `src/index.ts` — entry point, main polling loop, signal handlers
- `src/config.ts` — env + slate.json loading/validation, Config and SlateEntry types
- `src/api/data.ts` — Polymarket Data API (trade history)
- `src/api/gamma.ts` — Gamma API (market metadata + resolution status)
- `src/api/clob.ts` — CLOB API (order book snapshots, ghost-book detection)
- `src/enrich.ts` — trade enrichment: cache → Gamma → CLOB → fallback chain
- `src/notify.ts` — Telegram bot notifications
- `src/store.ts` — SQLite: seen_trades, market_cache, shadow_positions tables
- `src/types.ts` — Trade, MarketMeta, EnrichedTrade, ShadowPosition interfaces
- `src/evaluate-shadow.ts` — standalone PnL evaluation script (not part of main loop)
- `slate.json` — array of 10 whale wallets to monitor
- `ecosystem.config.cjs` — pm2 config (must be .cjs because package.json has "type": "module")

**Data flow:** poll Data API per wallet (200ms between wallets) → dedup via SQLite → enrich with Gamma/CLOB → format alert → send via Telegram → log shadow position (BUY only)

**Shadow PnL flow:** evaluate-shadow.ts loads open positions → checks Gamma for resolution → resolved markets use outcomePrices, open markets use CLOB bestBid for mark-to-market → updates SQLite → prints report

## Critical Rules

- **DO NOT use `@polymarket/clob-client` SDK.** It's for authenticated user trading. We use plain `fetch` against public endpoints.
- All three API endpoints are public/unauthenticated — plain `fetch` only:
  - `data-api.polymarket.com/trades?user={addr}`
  - `gamma-api.polymarket.com/markets?...` and `/events?slug=...`
  - `clob.polymarket.com/book?token_id={id}`
- Polymarket trade timestamps are in **seconds** — multiply by 1000 for JS Date
- CLOB book endpoint sometimes returns ghost data (bid ≤0.02, ask ≥0.98) — detect and return null
- Bids/asks come back in inconsistent sort order — always re-sort defensively
- Gamma `condition_ids=` returns empty for many newer markets — fall back to `/events?slug=` which works reliably
- Gamma `outcomePrices` field can be either a JSON-stringified string or an actual array — parse defensively
- On Telegram send failure: do NOT mark trade as seen (retries next poll)
- Shadow positions only log BUY trades (buy-and-hold approximation; SELLs are skipped)

## Coding Conventions

- `async`/`await` throughout, no `.then()` chains
- Functional style, no classes (except better-sqlite3's Database)
- No global state — pass dependencies as function parameters
- Wrap `fetch` in a helper returning `{ ok, data, status }` instead of throwing on non-2xx
- All times in milliseconds internally; human-readable only at notification time
- Logging via `console.log`/`console.error` (pm2 captures)
- Top-of-file comment explaining what the file does in 2-3 sentences

## SQLite Schema

Three tables in `data/tracker.db`:
- `seen_trades` — dedup (PK: transaction_hash)
- `market_cache` — Gamma metadata cache (PK: condition_id)
- `shadow_positions` — hypothetical copy-trade log (PK: transaction_hash, evaluation_status: open/resolved/unable_to_value)

## Out of MVP Scope

Web UI, multi-user support, WebSocket watcher, historical backfill, custom filters, retry logic for Telegram, smart batching, test suite. Do not add these.
