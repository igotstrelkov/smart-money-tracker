# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polymarket Smart-Money Tracker — monitors on-chain activity from whale wallets on Polymarket and sends Telegram alerts. MVP uses polling (30s intervals), not WebSockets.

## Stack

- TypeScript, ESM modules, run via `tsx` (no build step)
- Node.js 20+
- Dependencies: `tsx`, `dotenv`, `better-sqlite3` — nothing else unless a stage explicitly requires it
- SQLite for dedup + market cache
- pm2 for production process management

## Commands

```bash
# Run the app
npx tsx src/index.ts

# Production (pm2)
pm2 start ecosystem.config.js
pm2 logs smart-money-tracker
pm2 restart smart-money-tracker
```

## Architecture

Single-process polling loop. No monorepo, no workspaces.

- `src/index.ts` — entry point, main polling loop
- `src/config.ts` — env + slate.json loading/validation
- `src/api/data.ts` — Polymarket Data API (trade history)
- `src/api/gamma.ts` — Gamma API (market metadata)
- `src/api/clob.ts` — CLOB API (order book snapshots)
- `src/enrich.ts` — trade → alert text formatting
- `src/notify.ts` — Telegram bot notifications
- `src/store.ts` — SQLite setup and queries (seen_trades, market_cache)
- `src/types.ts` — shared TypeScript types
- `slate.json` — array of whale wallets to monitor

**Data flow:** poll Data API per wallet → dedup via SQLite → enrich with Gamma/CLOB data → format alert → send via Telegram

## Critical Rules

- **DO NOT use `@polymarket/clob-client` SDK.** It's for authenticated user trading. We use plain `fetch` against public endpoints.
- All three API endpoints are public/unauthenticated — plain `fetch` only:
  - `data-api.polymarket.com/trades?user={addr}`
  - `gamma-api.polymarket.com/markets?...`
  - `clob.polymarket.com/book?token_id={id}`
- Polymarket trade timestamps are in **seconds** — multiply by 1000 for JS Date
- CLOB book endpoint sometimes returns ghost data (bid 0.01, ask 0.99) — detect and skip
- Bids/asks come back in inconsistent sort order — always re-sort defensively
- Gamma `slug=` is exact-match; use `condition_ids=` for ID lookups

## Coding Conventions

- `async`/`await` throughout, no `.then()` chains
- Functional style, no classes (except better-sqlite3's Database)
- No global state — pass dependencies as function parameters
- Wrap `fetch` in a helper returning `{ ok, data, status }` instead of throwing on non-2xx
- All times in milliseconds internally; human-readable only at notification time
- Logging via `console.log`/`console.error` (pm2 captures)
- Top-of-file comment explaining what the file does in 2-3 sentences

## Development Workflow

The project follows stage-by-stage implementation from `implementation-plan.md`. Each stage produces a runnable artifact. Complete and verify one stage before starting the next.

## Out of MVP Scope

Web UI, multi-user support, WebSocket watcher, PnL tracking, historical backfill, custom filters, retry logic for Telegram, smart batching, test suite. Do not add these.
