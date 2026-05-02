# Polymarket Smart-Money Tracker — Implementation Plan

This is a stage-by-stage plan for building the MVP. Each stage produces a runnable artifact with verifiable acceptance criteria. Hand this document to an LLM and have it execute one stage at a time, verifying each before proceeding.

---

## How to Use This Plan

**For each stage:**

1. Feed the LLM the "Project Constants" section plus the current stage's spec
2. The LLM produces code
3. You run the verification command
4. If it passes, move to the next stage; if not, share the failure and have the LLM fix
5. Don't skip stages — each builds on the prior one

**Do NOT feed all stages at once.** LLMs do better one stage at a time with verification gates. This plan is designed for that workflow.

---

## Project Constants (read every stage)

These decisions are final. Do not re-litigate them; if the LLM tries to suggest alternatives, redirect.

**Stack:**

- TypeScript, ESM modules, run via `tsx` (no build step)
- Node.js 20+
- Single repository, no monorepo, no workspace
- Dependencies: `tsx`, `dotenv`, `better-sqlite3`. Nothing else unless a stage explicitly requires it.

**External services:**

- Polymarket Data API (`https://data-api.polymarket.com`) — trades endpoint
- Polymarket Gamma API (`https://gamma-api.polymarket.com`) — market metadata
- Polymarket CLOB API (`https://clob.polymarket.com`) — order book snapshots
- Telegram Bot API — notifications

**File layout (final):**

```
smart-money-tracker/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── slate.json
├── data/                 # gitignored, created at runtime
├── logs/                 # gitignored, pm2 writes here
├── src/
│   ├── index.ts          # entry point + main loop
│   ├── config.ts         # env + slate loading and validation
│   ├── api/
│   │   ├── data.ts       # Polymarket Data API
│   │   ├── gamma.ts      # Gamma API
│   │   └── clob.ts       # CLOB API
│   ├── enrich.ts         # trade → alert text
│   ├── notify.ts         # Telegram
│   ├── store.ts          # SQLite for dedup + market cache
│   └── types.ts          # shared TS types
└── ecosystem.config.js   # pm2 config
```

**Coding conventions:**

- `async`/`await` throughout, no `.then()` chains
- Wrap `fetch` calls in a small helper that returns `{ ok, data, status }` rather than throwing on non-2xx
- All log lines via `console.log`/`console.error` (pm2 captures them)
- All times in milliseconds in code; format human-readable only at notification time
- No global state. Pass dependencies as function parameters.
- No classes unless explicitly required (e.g., `better-sqlite3` returns a Database class). Functional style otherwise.
- Top-of-file comment explaining what the file does in 2-3 sentences

**Things that are explicitly NOT in MVP scope:**

- Web dashboard / UI
- Multi-user support / accounts / auth
- WebSocket-based watcher (we'll upgrade to this later; MVP polls)
- PnL tracking on alerts
- Historical trade replay / backfill on startup
- Custom filtering rules per user
- Retry-on-failure for failed Telegram sends
- Smart batching, rate-limiting beyond a simple delay
- Tests (we verify by running)

If the LLM proposes adding any of these, redirect.

**Critical clarification on the Polymarket SDK:**
The `@polymarket/clob-client` SDK exists and has authenticated methods like `clobClient.getTrades()`, `clobClient.getOpenOrders()`, etc. **DO NOT USE IT.** That SDK is for users querying _their own_ activity (requires private key + API key credentials). We are watching _other people's_ public trade history, which uses a different, unauthenticated endpoint: `data-api.polymarket.com/trades?user={address}`. The Data API endpoint is a plain `fetch` call with no auth. Similarly, the CLOB SDK has a `userSocket` example — that's also authenticated and scoped to a single user; it's not what we want.

The endpoints we use are all public/unauthenticated:

- `data-api.polymarket.com/trades?user={addr}` — public trade history for any wallet
- `gamma-api.polymarket.com/markets?...` — public market metadata
- `clob.polymarket.com/book?token_id={id}` — public order books

Plain `fetch` for all three. No SDK, no viem, no private key, no API keys.

**On the future WebSocket upgrade (post-MVP):**
When/if we replace polling with a WebSocket later, the right approach is **Alchemy's Polygon WebSocket** subscribing to `OrderFilled` events on the Polymarket CTFExchange contract (`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`), filtered by our slate addresses as maker or taker. **NOT** Polymarket's `userSocket` (which is per-user authenticated and only shows that one user's fills). This is out of scope for MVP but worth knowing if the LLM tries to "help" by adopting the userSocket pattern.

---

## Stage 1 — Project Skeleton + Telegram Smoke Test

**Goal:** Confirm Telegram bot works before writing anything else.

**Deliverables:**

- `package.json` with the exact dependencies listed above
- `tsconfig.json` (ESM, target ES2022, strict)
- `.gitignore` (node_modules, .env, data/, logs/, \*.db)
- `.env.example` with `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` placeholders
- `src/notify.ts` exporting `async function sendTelegram(text: string): Promise<void>`
  - Reads token and chat ID from env
  - Posts to `https://api.telegram.org/bot{token}/sendMessage`
  - Throws on non-2xx response with the body included in the error
- `src/index.ts` that imports `sendTelegram` and sends a test message: "Smart-money tracker — smoke test ✓"

**Verification:**

1. User creates Telegram bot via @BotFather, gets token
2. User sends `/start` to their bot, gets chat_id (instructions in README — see below)
3. User copies `.env.example` to `.env` and fills in real values
4. Run `npx tsx src/index.ts`
5. Test message appears in Telegram chat

**Also produce:** `README.md` with exactly these sections, and nothing else:

- "Setup" — npm install, env file, BotFather instructions, how to get chat_id (send any message to bot, then `curl https://api.telegram.org/bot{TOKEN}/getUpdates` and find `chat.id`)
- "Run locally" — `npx tsx src/index.ts`

**Do NOT yet build:** the slate file, polling, SQLite, or anything else. Just Telegram works.

---

## Stage 2 — Polymarket Data API Wrapper + Single-Wallet Polling

**Goal:** Watch one hardcoded wallet, log new trades to console (no Telegram alerts yet).

**Deliverables:**

- `src/api/data.ts` exporting `async function fetchTrades(wallet: string, limit?: number): Promise<Trade[]>`
  - Hits `https://data-api.polymarket.com/trades?user={wallet}&limit={limit}` (default limit 20)
  - Returns array of trades parsed from response
- `src/types.ts` defining the `Trade` interface with these fields (all that we need from the API):
  ```typescript
  export interface Trade {
    proxyWallet: string;
    side: "BUY" | "SELL";
    asset: string; // token id (string, very long number)
    conditionId: string; // 0x... market identifier
    size: number; // shares
    price: number; // 0..1
    timestamp: number; // unix seconds
    title: string;
    slug: string;
    outcome: string; // "Yes" | "No"
    transactionHash: string;
  }
  ```
- Update `src/index.ts` to:
  - Hardcode one wallet address: `0x5bec79df9add70a3892041ab1a5516b60f53b215` (guongAI)
  - Loop forever: every 30s, fetch the latest 5 trades, print them to stdout in a readable format
  - Use `setInterval` or a `while(true)` with `await sleep(30000)` — either is fine
  - On fetch error, log and continue (don't crash)

**Verification:**

1. Run `npx tsx src/index.ts`
2. Within 30 seconds, see at least one log line per recent trade printed to console
3. Wait 60 seconds: confirm trades repeat (no dedup yet — that's expected at this stage)
4. Kill with Ctrl+C; process exits cleanly

**Do NOT yet build:** dedup, multiple wallets, enrichment, or notifications.

---

## Stage 3 — SQLite Dedup

**Goal:** Stop re-printing the same trades on every poll.

**Deliverables:**

- `src/store.ts` exporting:
  - `function openDb(path: string): Database` — opens or creates SQLite file, runs migrations
  - `function hasSeenTrade(db, transactionHash: string): boolean`
  - `function markTradeSeen(db, transactionHash: string, walletAddress: string): void`
  - Schema (one table for now):
    ```sql
    CREATE TABLE IF NOT EXISTS seen_trades (
      transaction_hash TEXT PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    );
    ```
- Update `src/index.ts`:
  - Open `data/tracker.db` at startup (create `data/` if missing)
  - Filter fetched trades through `hasSeenTrade`; only print and mark new ones
  - Also skip trades whose `timestamp` is older than 5 minutes (stale-trade guard from architecture sketch)

**Verification:**

1. Delete `data/tracker.db` if it exists
2. Run `npx tsx src/index.ts`
3. First poll: prints all unseen recent trades
4. Second poll (30s later): prints nothing new (or prints only genuinely-new trades)
5. Kill, restart: still prints nothing new (state persisted to disk)

**Do NOT yet build:** market title enrichment, multiple wallets, or Telegram.

---

## Stage 4 — Slate File + Multiple Wallets

**Goal:** Watch all 10 wallets from a JSON file instead of one hardcoded address.

**Deliverables:**

- `slate.json` at the project root with this exact content:
  ```json
  [
    {
      "address": "0x5bec79df9add70a3892041ab1a5516b60f53b215",
      "name": "guongAI",
      "rationale": "highest monthly PnL, sports"
    },
    {
      "address": "0xea2b4224411e723499a803ce3f4758779fb31fc6",
      "name": "frankfrankfrank",
      "rationale": "362 markets, sports diversity"
    },
    {
      "address": "0xacb206b460a17382a734de8d931cc176307eb989",
      "name": "AppleTime67",
      "rationale": "all-rounder sports"
    },
    {
      "address": "0xa8e089ade142c95538e06196e09c85681112ad50",
      "name": "Wannac",
      "rationale": "high-conviction sizing"
    },
    {
      "address": "0x96489abcb9f583d6835c8ef95ffc923d05a86825",
      "name": "anoin123",
      "rationale": "politics + economics bridge"
    },
    {
      "address": "0x44c1dfe43260c94ed4f1d00de2e1f80fb113ebc1",
      "name": "aenews2",
      "rationale": "weather + politics + culture"
    },
    {
      "address": "0x0c0e270cf879583d6a0142fc817e05b768d0434e",
      "name": "The Spirit of Ukraine",
      "rationale": "multi-category, long history"
    },
    {
      "address": "0xe7a2052a8b7c6b865e3eb3d16300a4db7432ae70",
      "name": "TheOneto3",
      "rationale": "91% buys, 285 markets"
    },
    {
      "address": "0xe72bb501df5306c75c89383d48a1e81073fbb0a0",
      "name": "norrisfan",
      "rationale": "82% buys, 215 markets"
    },
    {
      "address": "0x85f031d069de300055900c4055c1baeb6bde3f67",
      "name": "RJW1",
      "rationale": "92% buys, $3.5k median"
    }
  ]
  ```
- `src/config.ts` exporting:
  - `function loadConfig(): Config` — reads .env via `dotenv`, validates, returns typed object
  - `function loadSlate(): SlateEntry[]` — reads slate.json, validates each entry has the three required fields
  - Type definitions for `Config` and `SlateEntry`
  - Throws clear error messages if anything's missing
- Update `src/index.ts`:
  - Load slate on startup, log "Watching N wallets: name1, name2, ..."
  - Replace single-wallet poll with a loop over all slate entries
  - Add a 200ms delay between wallet polls (gentle pacing)
  - Each printed trade includes the slate name (not just address)

**Verification:**

1. Run `npx tsx src/index.ts`
2. Startup log shows all 10 names
3. Within 5 minutes, see at least one trade across the 10 wallets (these are active wallets; some will have traded recently)
4. Each printed line shows wallet name (e.g. "[guongAI]") not just address

**Do NOT yet build:** enrichment, Telegram, or current-bid-ask context.

---

## Stage 5 — Telegram Notifications (Plain)

**Goal:** Replace `console.log` with Telegram message for each new trade.

**Deliverables:**

- Update `src/index.ts`:
  - For each new trade, call `sendTelegram` with a plain message:
    ```
    [guongAI] BUY YES on "Will the Knicks win Game 7?" at $0.42 × 500 ($210)
    https://polymarket.com/event/{slug}
    ```
  - Construct the URL as `https://polymarket.com/event/{trade.slug}`
  - Continue logging to console too (so pm2 logs show alerts)
  - On Telegram failure: log error, do NOT mark trade as seen (so it retries next poll)

**Verification:**

1. Run `npx tsx src/index.ts`
2. Within ~5 minutes, receive at least one Telegram message from one of the slate wallets
3. The message has the format above with real wallet name, real market title, real numbers
4. The link opens to a real Polymarket page

**Do NOT yet build:** enrichment with current bid/ask, Gamma API caching, or pm2 deployment.

---

## Stage 6 — Gamma API Wrapper + Market Cache

**Goal:** Cache market titles in SQLite to avoid hammering Gamma API on every alert (and for future enrichment).

**Note:** in Stage 5, `trade.title` and `trade.slug` come directly from the Data API response. This stage is preparation for fields the Data API doesn't include — adding the cache infrastructure now means later stages just use it.

**Deliverables:**

- `src/api/gamma.ts` exporting:
  - `async function fetchMarketByConditionId(conditionId: string): Promise<MarketMeta | null>`
  - Hits `https://gamma-api.polymarket.com/markets?condition_ids={conditionId}` (or appropriate endpoint — verify via Polymarket docs at https://docs.polymarket.com)
  - Returns `{ conditionId, title, slug, eventSlug }` or `null` if 404
- Update `src/store.ts` to add a market cache table:
  ```sql
  CREATE TABLE IF NOT EXISTS market_cache (
    condition_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    event_slug TEXT,
    cached_at INTEGER NOT NULL
  );
  ```
- Add to `src/store.ts`:
  - `function getCachedMarket(db, conditionId): MarketMeta | null`
  - `function setCachedMarket(db, market: MarketMeta): void`
- New `src/enrich.ts` exporting:
  - `async function enrichTrade(db, trade: Trade): Promise<EnrichedTrade>`
  - For now: returns `{ ...trade, eventUrl: "https://polymarket.com/event/{eventSlug || slug}" }`
  - Uses cache; falls back to Gamma; if Gamma fails, falls back to `trade.slug`
- Update `src/index.ts` to call `enrichTrade` before sending to Telegram

**Verification:**

1. Run `npx tsx src/index.ts`
2. Receive a Telegram alert with a `polymarket.com/event/...` link
3. Inspect SQLite: `sqlite3 data/tracker.db "SELECT * FROM market_cache LIMIT 5;"` shows cached entries
4. Restart and re-alert (delete a transaction hash from `seen_trades` to test): second alert should NOT hit Gamma (verified by checking logs — add a debug log on cache hit/miss)

**Do NOT yet build:** CLOB current-price enrichment.

---

## Stage 7 — CLOB Current Bid/Ask Enrichment

**Goal:** Add "current ask is X, slippage if you copy now is Yc" to alerts.

**Deliverables:**

- `src/api/clob.ts` exporting:
  - `async function fetchOrderBook(tokenId: string): Promise<OrderBookSnapshot | null>`
  - Hits `https://clob.polymarket.com/book?token_id={tokenId}`
  - Returns `{ bestBid, bestAsk, depthWithin2cUsd }` or `null` if 404
  - Defensively sorts bids descending and asks ascending (the API has documented inconsistencies — see project lessons)
  - Detects ghost-book pattern (bid 0.01 + ask 0.99): returns `null` for these
- Update `src/enrich.ts`:
  - Pull order book for `trade.asset` (token id)
  - If successful: compute slippage = `bestAsk - trade.price` (positive means it's gotten more expensive since the leader bought)
  - Add to alert: current ask, depth within 2¢, slippage
- Update Telegram message format:
  ```
  🐋 [guongAI] BUY YES on "Will the Knicks win Game 7?"
  Their fill: $0.42 × 500 = $210
  Current ask: $0.45 ($150 within 2¢)
  Slippage if you copy: +3¢
  → https://polymarket.com/event/{eventSlug}
  ```
- If order book fetch fails or returns ghost: fall back to the simpler Stage 5 format

**Verification:**

1. Run `npx tsx src/index.ts`
2. Receive an alert with the slippage line
3. Click the link, verify the current ask shown matches Polymarket's UI (within a second or two of network latency)
4. Verify ghost-book handling: if any wallet trades on a market with a ghost book, alert falls back to simple format and logs a warning (you may not hit this organically; it's defensive)

**Do NOT yet build:** pm2 deployment, advanced filtering, or anything else.

---

## Stage 7.5 — Shadow PnL Logging

**Goal:** Record what a hypothetical copy-trade would have looked like for every alert. No PnL math here yet — that's Stage 7.6. This stage just persists the data needed to answer "would copying these alerts have made money?" later.

**Why this matters:** Before considering automated execution (which is explicitly out of MVP scope), we want to validate that the slate's signals are actually profitable. Shadow logging is the cheapest possible test — it costs nothing, risks nothing, and after a month produces real data on whether the alerts have positive expected value.

**Important framing:** This is "buy-and-hold approximation." We do NOT track when leaders sell, so positions stay open in the shadow log indefinitely until the underlying market resolves. This will make the PnL slightly less accurate than reality (a leader might have exited a winning position, locking in profit; the shadow holds it through resolution and might capture a loss instead). Acknowledge this in the eventual report rather than trying to fix it. The simpler version is sufficient to answer "are these alerts net positive?" — which is the question we actually need answered.

**Deliverables:**

- Update `src/store.ts` to add a new table:
  ```sql
  CREATE TABLE IF NOT EXISTS shadow_positions (
    transaction_hash TEXT PRIMARY KEY,
    leader_wallet TEXT NOT NULL,
    leader_name TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    side TEXT NOT NULL,
    leader_fill_price REAL NOT NULL,
    hypothetical_entry_price REAL NOT NULL,
    hypothetical_size_usd REAL NOT NULL,
    market_title TEXT NOT NULL,
    market_slug TEXT NOT NULL,
    alert_timestamp INTEGER NOT NULL,
    evaluation_status TEXT NOT NULL DEFAULT 'open',
    evaluated_at INTEGER,
    evaluated_value_usd REAL,
    evaluated_pnl_usd REAL
  );
  ```
- Add to `src/store.ts`:
  - `function logShadowPosition(db, position: ShadowPosition): void`
  - `function getOpenShadowPositions(db): ShadowPosition[]`
  - `function updateShadowEvaluation(db, txHash, value, pnl, status): void`
- Add `ShadowPosition` type to `src/types.ts`
- Update `src/index.ts`:
  - After successfully sending a Telegram alert, call `logShadowPosition` with:
    - `hypothetical_entry_price` = current best ask from CLOB (the price you'd pay if buying NOW); fall back to `trade.price + 0.02` if order book unavailable (defensive — assume 2¢ slippage)
    - `hypothetical_size_usd` = a fixed `SHADOW_SIZE_USD` constant from config (default $10)
    - `side` = "BUY" only — for MVP, only log buy alerts; sells are excluded since they typically close positions in the leader's account, not open new ones
    - All other fields copied from the trade and enrichment
  - Skip shadow logging entirely if the trade was a SELL (since this is buy-and-hold approximation and we're not tracking exits)
- Add `SHADOW_SIZE_USD=10` to `.env.example` and `src/config.ts`

**Verification:**

1. Run `npx tsx src/index.ts`
2. After receiving a Telegram alert, check SQLite:
   ```bash
   sqlite3 data/tracker.db "SELECT leader_name, market_title, hypothetical_entry_price, hypothetical_size_usd, evaluation_status FROM shadow_positions ORDER BY alert_timestamp DESC LIMIT 5;"
   ```
3. Confirm the row exists with `evaluation_status = 'open'`
4. Confirm `hypothetical_entry_price` is reasonable (close to but possibly worse than the leader's `leader_fill_price`)
5. Confirm sell-side alerts do NOT create shadow positions

**Do NOT yet build:** the evaluation script, PnL math, or any reporting. Just record positions.

---

## Stage 7.6 — Shadow PnL Evaluation Script

**Goal:** A standalone script you run on demand that walks all shadow positions, marks them to current market state, and prints a PnL report. NOT integrated into the main watcher — kept separate so it can be run weekly/monthly without affecting the alerting loop.

**Deliverables:**

- New file `src/evaluate-shadow.ts` that:
  1. Opens the SQLite database
  2. Loads all shadow positions (both open and previously evaluated)
  3. For each open position:
     - Fetch the market via Gamma API by `condition_id`
     - If `closed: true`: parse `outcomePrices` field (JSON-stringified array). Final value = `outcomePrices[outcomeIndex] × shares_held`. Note that `shares_held = hypothetical_size_usd / hypothetical_entry_price`. Status becomes `resolved`.
     - If `closed: false`: fetch order book for `token_id`, use `bestBid` (conservative — what you'd actually sell into). Current value = `bestBid × shares_held`. Status stays `open` but `evaluated_value_usd` is updated for mark-to-market reporting.
     - If Gamma returns 404 or the market is in an unusual state: status becomes `unable_to_value`, log it
  4. Compute PnL = `evaluated_value_usd - hypothetical_size_usd` for each
  5. Update SQLite with the evaluation results
  6. Print a structured report:

     ```
     =========================================
      Shadow PnL Report — YYYY-MM-DD
     =========================================
       total alerts logged:        N
       resolved:                   X
       still open (mark-to-market): Y
       unable to value:            Z

       resolved PnL:               $A
       open mark-to-market PnL:    $B
       combined PnL:               $C

       per-leader breakdown:
         guongAI         12 alerts  +$23.40  (-$5 / +$28)
         frankfrankfrank 18 alerts  -$3.20   (-$11 / +$8)
         ...

       per-category breakdown (using leaderboard category tags):
         sports          25 alerts  +$15.20
         politics         8 alerts  +$3.80
         ...

       caveats applied:
       - Buy-and-hold approximation; ignores leader exits
       - Hypothetical entry uses best ask at alert time, not actual fill simulation
       - Open positions valued at current best bid (conservative)
       - Polymarket fees not deducted (real PnL would be ~2% lower)
     ```

- Run it with: `npx tsx src/evaluate-shadow.ts`
- Output goes to stdout only. No Telegram integration in this stage.

**Verification:**

1. After Stage 7.5 has been collecting data for at least a few hours (so there's something to evaluate), run `npx tsx src/evaluate-shadow.ts`
2. The report prints with non-zero counts in at least the "still open" bucket
3. SQLite reflects updates: `SELECT evaluation_status, COUNT(*) FROM shadow_positions GROUP BY evaluation_status;`
4. Re-running the script is idempotent — it updates existing rows rather than crashing or duplicating
5. If a market has resolved between two runs, its row should transition from `open` to `resolved`

**Operational note (not deliverable, but mention in README):**

- Run this manually weekly or monthly to track strategy health
- Don't read into the first week's results — sample size will be too small
- After 30+ resolved alerts: the PnL number is meaningful enough to inform a decision about whether the slate is worth following at all

**Do NOT yet build:** Telegram integration of the report, automated execution based on shadow performance, or any feedback loop into slate selection. The script is read-only on the live system; you decide manually what to do with the numbers.

---

## Stage 8 — pm2 Deployment Config + Production Polish

**Goal:** Make it deployable to a VPS under pm2 with proper restart and logging.

**Deliverables:**

- `ecosystem.config.js`:
  ```javascript
  module.exports = {
    apps: [
      {
        name: "smart-money-tracker",
        script: "tsx",
        args: "src/index.ts",
        autorestart: true,
        watch: false,
        max_memory_restart: "200M",
        error_file: "logs/error.log",
        out_file: "logs/out.log",
        log_date_format: "YYYY-MM-DD HH:mm:ss",
        env: { NODE_ENV: "production" },
      },
    ],
  };
  ```
- Update `src/index.ts`:
  - On `SIGINT` and `SIGTERM`, log shutdown message and exit cleanly (close DB, etc.)
  - On unhandled rejection: log and crash (let pm2 restart)
  - Startup log includes: timestamp, slate count, poll interval, db path
- Add to `README.md`:
  - "Deployment" section with the exact VPS commands:
    ```bash
    git clone <repo>
    cd smart-money-tracker
    cp .env.example .env  # edit with real values
    npm install
    mkdir -p data logs
    pm2 start ecosystem.config.js
    pm2 save
    pm2 startup  # follow the printed command
    ```
  - "Operations" section:
    - `pm2 logs smart-money-tracker` — tail logs
    - `pm2 restart smart-money-tracker` — restart after slate.json edit
    - `pm2 status` — health check

**Verification:**

1. On VPS: clone, install, configure, start
2. `pm2 status` shows process online
3. Within 5 minutes: receive at least one Telegram alert
4. `pm2 logs` shows trades being processed
5. `pm2 restart smart-money-tracker` works without losing dedup state (SQLite persists)
6. Reboot the VPS: pm2 auto-starts the tracker, alerts resume

**Do NOT build:** monitoring, metrics, alerting on the alerter, or any meta-features. If the tracker breaks, you'll notice from missing alerts. That's enough.

---

## Stage 9 (optional) — Slate Reload on SIGHUP

**Goal:** Edit slate.json and reload without restarting (preserves the seen_trades cache).

This is genuinely optional. Skip it if Stage 8 works and you're happy. The pm2 restart approach is fine.

**Deliverables:**

- Listen for `SIGHUP`, reload slate.json, log new wallet count
- Send `kill -HUP <pid>` to reload

**Verification:**

1. Edit slate.json, swap a wallet
2. `pm2 sendSignal SIGHUP smart-money-tracker`
3. Logs show new wallet count
4. Alerts now come from the new wallet

---

## Definition of Done

The MVP is "done" when:

1. The tracker runs on your VPS under pm2, autorestarts on crash, autostarts on reboot
2. You receive Telegram alerts within ~30-60 seconds of any of the 10 slate wallets trading
3. Each alert includes: wallet name, side, market title, fill price + size, current ask, slippage, and link
4. The same trade never alerts twice
5. Restarting the process does not lose dedup state
6. The slate is edited in `slate.json` (not in code) and a restart picks up changes

That's the end of the MVP. Everything beyond is V2: WebSocket upgrade, web dashboard, multi-user, PnL tracking, etc.

---

## Common Failure Modes the LLM Should Watch For

These are real issues from the project's research phase. The LLM should know them.

- **Polymarket Gamma `slug=` query parameter is exact-match, not substring.** Use `condition_ids=` for lookups by ID.
- **CLOB `/book` endpoint sometimes returns ghost data** (bid 0.01, ask 0.99) for active markets. Detect and skip.
- **Bids and asks come back in inconsistent sort order.** Always re-sort defensively.
- **`/prices-history` endpoint returns empty for markets older than ~6 months.** Not a concern for MVP (we only look at live trades) but worth knowing.
- **Telegram has a 4096-character message limit.** Truncate or split if needed (unlikely to hit at MVP scope).
- **Polymarket trade timestamps are in seconds, not milliseconds.** Multiply by 1000 before passing to `Date()`.

---

## Architectural Decisions That Are Final

If the LLM proposes any of these, push back:

- "Should we use viem instead of plain fetch?" — No, plain fetch.
- "Should we use the @polymarket/clob-client SDK?" — No, that's for authenticated user trading. Our endpoints are public.
- "Should we add a queue between fetch and notify?" — No, synchronous flow.
- "Should we add retry logic for failed Telegram?" — No, log and skip.
- "Should we use Prisma / TypeORM?" — No, raw better-sqlite3.
- "Should we add input validation with zod?" — No for MVP, hand-written checks are fine.
- "Should we add unit tests?" — No, verify by running.
- "Should the SQLite tables have indexes beyond the primary key?" — No for MVP, the data is too small to matter.
- "Should we add a /healthz endpoint?" — No, pm2 handles process health.
- "Should we abstract the API clients behind interfaces for swappability?" — No, just functions.

If the LLM offers an "improvement" not in the plan, the answer is "ship the plan, then we'll see."
