/**
 * Monthly slate review.
 *
 * Run this once a month. It will tell you:
 *   1. Whether each of your 10 slate wallets is still healthy
 *      (active, directional, not drifted into market-making)
 *   2. Whether any non-slate wallets currently beat your weakest slate
 *      member by a meaningful margin — i.e. someone you should
 *      consider swapping in
 *
 * Output is a plain-text report. No state is persisted; just run it,
 * read it, decide manually whether to update the slate.
 *
 * To update the slate: edit the SLATE constant below and re-run.
 *
 * Run with:
 *   npx tsx review-slate.ts
 */

const DATA_API = "https://data-api.polymarket.com";
const USER_AGENT = "polymarket-slate-review (you@example.com)";
const DELAY_MS = 100;

// ───────────────────────── Your slate ─────────────────────

// Edit this list when you decide to swap wallets in/out.
// Order doesn't matter. Names are for display only.
const SLATE: Array<{ address: string; name: string; rationale: string }> = [
  { address: "0x5bec79df9add70a3892041ab1a5516b60f53b215", name: "guongAI", rationale: "highest monthly PnL, sports" },
  { address: "0xea2b4224411e723499a803ce3f4758779fb31fc6", name: "frankfrankfrank", rationale: "362 markets, sports diversity" },
  { address: "0xacb206b460a17382a734de8d931cc176307eb989", name: "AppleTime67", rationale: "all-rounder sports" },
  { address: "0x44c1dfe43260c94ed4f1d00de2e1f80fb113ebc1", name: "aenews2", rationale: "politics + weather + culture" },
  { address: "0x96489abcb9f583d6835c8ef95ffc923d05a86825", name: "anoin123", rationale: "politics + economics bridge" },
  { address: "0x0c0e270cf879583d6a0142fc817e05b768d0434e", name: "The Spirit of Ukraine>UMA", rationale: "multi-category, long history" },
  // Add the rest of your slate here. Examples from the data we have:
  // Erasmus, lebronjames23, madril, poorsob — fill in once you confirm
];

// ───────────────────────── Discovery config ───────────────

const DISCOVERY_QUERIES = [
  { category: "OVERALL", timePeriod: "MONTH" },
  { category: "POLITICS", timePeriod: "MONTH" },
  { category: "SPORTS", timePeriod: "MONTH" },
  { category: "CRYPTO", timePeriod: "MONTH" },
  { category: "WEATHER", timePeriod: "MONTH" },
  { category: "ECONOMICS", timePeriod: "MONTH" },
];
const PER_CATEGORY_LIMIT = 50;
const TRADES_PER_WALLET = 1000;

// A non-slate wallet must score this much above the weakest slate member
// to count as a "consider swapping" candidate. 0.10 filters noise.
const SWAP_THRESHOLD = 0.10;

// ───────────────────────── Types ──────────────────────────

interface LeaderboardEntry {
  proxyWallet: string;
  userName?: string;
  vol?: number;
  pnl?: number;
  xUsername?: string;
}

interface Trade {
  side?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  title?: string;
  slug?: string;
}

interface WalletScore {
  address: string;
  userName: string;
  monthlyPnl: number;
  inSlate: boolean;
  slateName?: string;
  trades: number;
  spanDays: number;
  buyPct: number;
  tradesPerDay: number;
  medianTradeUsd: number;
  uniqueMarkets: number;
  recentDays: number;
  topMarketShare: number;
  scoreDirectional: number;
  scoreActivityFreq: number;
  scoreTradeSize: number;
  scoreDiversity: number;
  scoreRecency: number;
  scoreNotConcentrated: number;
  composite: number;
  flags: string[];
}

// ───────────────────────── Helpers ────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(url: string): Promise<{ ok: boolean; data: T | null; status: number }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, data: null, status: res.status };
    return { ok: true, data: (await res.json()) as T, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
}

function num(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "string") {
    const v = parseFloat(x);
    return Number.isFinite(v) ? v : 0;
  }
  return 0;
}

function getSide(t: Trade): "BUY" | "SELL" | "?" {
  const s = (t.side ?? "").toString().toUpperCase();
  if (s.includes("BUY")) return "BUY";
  if (s.includes("SELL")) return "SELL";
  return "?";
}

function getTimestampMs(t: Trade): number {
  const ts = t.timestamp;
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts === "string") {
    const v = parseInt(ts);
    if (Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  }
  return 0;
}

function bandedScore(value: number, sweet: [number, number], penalty: [number, number]): number {
  if (value >= sweet[0] && value <= sweet[1]) return 1.0;
  if (value >= penalty[0] && value <= penalty[1]) return 0.5;
  return 0;
}
function rampScore(value: number, lo: number, hi: number): number {
  if (value <= lo) return 0;
  if (value >= hi) return 1;
  return (value - lo) / (hi - lo);
}
function inverseRampScore(value: number, lo: number, hi: number): number {
  if (value <= lo) return 1;
  if (value >= hi) return 0;
  return 1 - (value - lo) / (hi - lo);
}

// ───────────────────────── Fetching ───────────────────────

async function fetchLeaderboardCandidates(): Promise<Map<string, LeaderboardEntry>> {
  const candidates = new Map<string, LeaderboardEntry>();
  for (const q of DISCOVERY_QUERIES) {
    const url = `${DATA_API}/v1/leaderboard?category=${q.category}&timePeriod=${q.timePeriod}&orderBy=PNL&limit=${PER_CATEGORY_LIMIT}`;
    await sleep(DELAY_MS);
    const r = await get<LeaderboardEntry[]>(url);
    if (!r.ok || !r.data) continue;
    for (const e of r.data) {
      if (!e.proxyWallet) continue;
      if (!candidates.has(e.proxyWallet)) candidates.set(e.proxyWallet, e);
    }
  }
  return candidates;
}

async function fetchTrades(wallet: string, max: number): Promise<Trade[]> {
  const all: Trade[] = [];
  let cursor: number | string | null = null;
  const pageSize = 500;
  for (let page = 0; page < Math.ceil(max / pageSize); page++) {
    const url =
      cursor !== null
        ? `${DATA_API}/trades?user=${wallet}&limit=${pageSize}&before=${cursor}`
        : `${DATA_API}/trades?user=${wallet}&limit=${pageSize}`;
    await sleep(DELAY_MS);
    const r = await get<Trade[]>(url);
    if (!r.ok || !r.data || r.data.length === 0) break;
    all.push(...r.data);
    cursor = r.data[r.data.length - 1].timestamp ?? null;
    if (cursor === null) break;
    if (r.data.length < pageSize) break;
  }
  return all.slice(0, max);
}

// ───────────────────────── Scoring ────────────────────────

function scoreWallet(
  address: string,
  userName: string,
  monthlyPnl: number,
  inSlate: boolean,
  slateName: string | undefined,
  trades: Trade[],
): WalletScore {
  const score: WalletScore = {
    address, userName, monthlyPnl, inSlate, slateName,
    trades: trades.length,
    spanDays: 0, buyPct: 0, tradesPerDay: 0, medianTradeUsd: 0,
    uniqueMarkets: 0, recentDays: 999, topMarketShare: 0,
    scoreDirectional: 0, scoreActivityFreq: 0, scoreTradeSize: 0,
    scoreDiversity: 0, scoreRecency: 0, scoreNotConcentrated: 0,
    composite: 0, flags: [],
  };

  if (trades.length === 0) {
    score.flags.push("no trades available");
    return score;
  }

  const timestamps = trades.map(getTimestampMs).filter((t) => t > 0).sort();
  if (timestamps.length > 0) {
    score.spanDays = (timestamps[timestamps.length - 1] - timestamps[0]) / 86400_000;
    score.tradesPerDay = trades.length / Math.max(score.spanDays, 1);
    score.recentDays = (Date.now() - timestamps[timestamps.length - 1]) / 86400_000;
  }

  let buys = 0, sells = 0;
  for (const t of trades) {
    const side = getSide(t);
    if (side === "BUY") buys++;
    else if (side === "SELL") sells++;
  }
  score.buyPct = (buys + sells) > 0 ? (100 * buys) / (buys + sells) : 0;

  const titles = new Map<string, number>();
  for (const t of trades) {
    const k = (t.title ?? t.slug ?? "(unknown)").toString();
    titles.set(k, (titles.get(k) ?? 0) + 1);
  }
  score.uniqueMarkets = titles.size;
  const top = [...titles.values()].sort((a, b) => b - a)[0] ?? 0;
  score.topMarketShare = top / trades.length;

  const sizesUsd = trades.map((t) => num(t.size) * num(t.price)).filter((v) => v > 0).sort((a, b) => a - b);
  if (sizesUsd.length > 0) {
    score.medianTradeUsd = sizesUsd[Math.floor(sizesUsd.length / 2)];
  }

  score.scoreDirectional = bandedScore(score.buyPct, [60, 95], [55, 99]);
  score.scoreActivityFreq = bandedScore(score.tradesPerDay, [1, 20], [0.5, 50]);
  score.scoreTradeSize = rampScore(score.medianTradeUsd, 10, 100);
  score.scoreDiversity = rampScore(score.uniqueMarkets, 10, 50);
  score.scoreRecency = inverseRampScore(score.recentDays, 7, 30);
  score.scoreNotConcentrated = inverseRampScore(score.topMarketShare, 0.2, 0.5);

  score.composite =
    score.scoreDirectional * 0.25 +
    score.scoreActivityFreq * 0.15 +
    score.scoreTradeSize * 0.15 +
    score.scoreDiversity * 0.15 +
    score.scoreRecency * 0.20 +
    score.scoreNotConcentrated * 0.10;

  // Decay flags — what changed about this wallet
  if (score.recentDays > 14) score.flags.push(`inactive ${score.recentDays.toFixed(0)}d`);
  if (score.buyPct >= 45 && score.buyPct <= 55 && score.tradesPerDay > 20) {
    score.flags.push("market-maker pattern");
  }
  if (score.medianTradeUsd < 10) score.flags.push("trade size collapsed");
  if (score.uniqueMarkets < 10) score.flags.push("low diversity");
  if (score.topMarketShare > 0.5) score.flags.push("concentrated single-market");

  return score;
}

// ───────────────────────── Main ───────────────────────────

async function main() {
  console.log("=========================================");
  console.log(" Monthly slate review");
  console.log("=========================================\n");
  console.log(`  date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`  current slate: ${SLATE.length} wallets\n`);

  // STEP 1 — Re-score current slate
  console.log("STEP 1 — Re-score current slate\n");
  const slateScores: WalletScore[] = [];
  for (const w of SLATE) {
    process.stdout.write(`  ${w.name.padEnd(28)} ... `);
    const trades = await fetchTrades(w.address, TRADES_PER_WALLET);
    const score = scoreWallet(w.address, w.name, 0, true, w.name, trades);
    slateScores.push(score);
    process.stdout.write(`${trades.length} trades, score ${score.composite.toFixed(2)}`);
    if (score.flags.length > 0) process.stdout.write(`  [${score.flags.join(", ")}]`);
    process.stdout.write("\n");
  }

  // STEP 2 — Pull leaderboard for new candidates
  console.log("\nSTEP 2 — Pull current leaderboard\n");
  const candidates = await fetchLeaderboardCandidates();
  const slateAddresses = new Set(SLATE.map((w) => w.address.toLowerCase()));
  const newCandidates = [...candidates.values()].filter(
    (c) => !slateAddresses.has(c.proxyWallet.toLowerCase()),
  );
  console.log(`  ${candidates.size} unique on leaderboard`);
  console.log(`  ${newCandidates.length} not currently in slate\n`);

  // STEP 3 — Score the threshold against weakest slate member
  const weakest = slateScores.reduce((a, b) => (a.composite < b.composite ? a : b));
  const threshold = weakest.composite + SWAP_THRESHOLD;
  console.log(`STEP 3 — Score new candidates that could beat slate\n`);
  console.log(`  weakest slate member: ${weakest.userName} (score ${weakest.composite.toFixed(2)})`);
  console.log(`  swap threshold: ${threshold.toFixed(2)} (= weakest + ${SWAP_THRESHOLD})\n`);

  // We score every non-slate candidate, then filter. With ~150 candidates
  // and ~3 minutes of fetch time, that's tolerable.
  const newScores: WalletScore[] = [];
  for (let i = 0; i < newCandidates.length; i++) {
    const c = newCandidates[i];
    const name = c.userName ?? c.proxyWallet.slice(0, 10);
    process.stdout.write(`  [${i + 1}/${newCandidates.length}] ${name.slice(0, 24).padEnd(24)} `);
    const trades = await fetchTrades(c.proxyWallet, TRADES_PER_WALLET);
    const score = scoreWallet(c.proxyWallet, name, c.pnl ?? 0, false, undefined, trades);
    newScores.push(score);
    process.stdout.write(`score ${score.composite.toFixed(2)}\n`);
  }

  // ─── Action report ───
  console.log("\n=========================================");
  console.log(" ACTION REPORT");
  console.log("=========================================\n");

  // Decayed slate members
  const decayed = slateScores.filter((s) => s.flags.length > 0 || s.composite < 0.7);
  console.log("Slate members showing concerns:");
  if (decayed.length === 0) {
    console.log("  ✓ All 10 slate members healthy.\n");
  } else {
    for (const s of decayed) {
      console.log(`  ⚠ ${s.userName}  (score ${s.composite.toFixed(2)})`);
      if (s.flags.length > 0) console.log(`     flags: ${s.flags.join(", ")}`);
      console.log(
        `     ${s.trades} trades, ${s.buyPct.toFixed(0)}% buys, $${s.medianTradeUsd.toFixed(0)} med, last ${s.recentDays.toFixed(0)}d ago`,
      );
    }
    console.log("");
  }

  // New candidates that beat the threshold
  const swapCandidates = newScores
    .filter((s) => s.composite >= threshold && s.flags.length === 0)
    .sort((a, b) => b.composite - a.composite);

  console.log("New candidates worth considering:");
  if (swapCandidates.length === 0) {
    console.log(`  None scored above ${threshold.toFixed(2)} cleanly. Slate stays as-is.\n`);
  } else {
    console.log(`  ${swapCandidates.length} non-slate wallets beat the swap threshold:\n`);
    for (const s of swapCandidates.slice(0, 10)) {
      console.log(
        `  ${s.userName.padEnd(24)} score ${s.composite.toFixed(2)}  ` +
        `${s.buyPct.toFixed(0)}% buys  $${s.medianTradeUsd.toFixed(0)} med  ` +
        `${s.uniqueMarkets} mkts  rec ${s.recentDays.toFixed(0)}d  PnL $${s.monthlyPnl.toFixed(0)}`,
      );
      console.log(`    address: ${s.address}`);
    }
    console.log("");
  }

  // ─── Recommendation ───
  console.log("=========================================");
  console.log(" RECOMMENDATION");
  console.log("=========================================\n");

  if (decayed.length === 0 && swapCandidates.length === 0) {
    console.log("  No changes needed. Slate is healthy and no obvious upgrades.\n");
  } else {
    if (decayed.length > 0) {
      console.log(`  Drop candidates: ${decayed.map((s) => s.userName).join(", ")}`);
    }
    if (swapCandidates.length > 0) {
      console.log(`  Swap-in candidates: ${swapCandidates.slice(0, decayed.length || 3).map((s) => s.userName).join(", ")}`);
    }
    console.log(`\n  Edit SLATE constant at top of this file and re-run to verify.\n`);
  }
}

main().catch((e) => {
  console.error("\nReview failed:", e.message);
  process.exit(1);
});
