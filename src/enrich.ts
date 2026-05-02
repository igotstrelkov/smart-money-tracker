// Trade enrichment layer.
// Resolves market metadata via cache → Gamma API → fallback chain.
// Fetches CLOB order book for current ask/slippage data.
// Produces an EnrichedTrade with the best available data.

import type Database from "better-sqlite3";
import type { Trade, EnrichedTrade } from "./types.js";
import { getCachedMarket, setCachedMarket } from "./store.js";
import { fetchMarketByConditionId } from "./api/gamma.js";
import { fetchOrderBook } from "./api/clob.js";

export async function enrichTrade(
  db: Database.Database,
  trade: Trade
): Promise<EnrichedTrade> {
  // --- Market metadata (Gamma) ---
  let eventSlug: string | null = null;

  const cached = getCachedMarket(db, trade.conditionId);
  if (cached) {
    console.log(`Cache hit for market ${trade.conditionId.slice(0, 10)}…`);
    eventSlug = cached.eventSlug;
  } else {
    console.log(`Cache miss for market ${trade.conditionId.slice(0, 10)}…, fetching from Gamma`);
    try {
      const market = await fetchMarketByConditionId(trade.conditionId, trade.slug);
      if (market) {
        setCachedMarket(db, market);
        eventSlug = market.eventSlug;
      }
    } catch (err) {
      console.error(`Gamma fetch failed for ${trade.conditionId}:`, err);
    }
  }

  const slug = trade.eventSlug || eventSlug || trade.slug;
  const eventUrl = `https://polymarket.com/event/${slug}`;

  // --- Order book (CLOB) ---
  let bestAsk: number | null = null;
  let depthWithin2cUsd: number | null = null;
  let slippage: number | null = null;

  try {
    const book = await fetchOrderBook(trade.asset);
    if (book) {
      bestAsk = book.bestAsk;
      depthWithin2cUsd = book.depthWithin2cUsd;
      slippage = book.bestAsk - trade.price;
    }
  } catch (err) {
    console.error(`CLOB fetch failed for asset ${trade.asset.slice(0, 10)}…:`, err);
  }

  return { ...trade, eventUrl, bestAsk, depthWithin2cUsd, slippage };
}
