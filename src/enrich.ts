// Trade enrichment layer.
// Resolves market metadata via cache → Gamma API → fallback chain.
// Produces an EnrichedTrade with the best available eventUrl.

import type Database from "better-sqlite3";
import type { Trade, EnrichedTrade } from "./types.js";
import { getCachedMarket, setCachedMarket } from "./store.js";
import { fetchMarketByConditionId } from "./api/gamma.js";

export async function enrichTrade(
  db: Database.Database,
  trade: Trade
): Promise<EnrichedTrade> {
  let eventSlug: string | null = null;

  // Try cache first
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

  const slug = eventSlug || trade.slug;
  const eventUrl = `https://polymarket.com/event/${slug}`;

  return { ...trade, eventUrl };
}
