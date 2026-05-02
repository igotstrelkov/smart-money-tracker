// Polymarket Gamma API wrapper.
// Fetches market metadata (title, slug, eventSlug) by condition ID or slug.
// Tries /markets?condition_ids= first, falls back to /events?slug=.
// Endpoint is public/unauthenticated — plain fetch, no SDK.

import type { MarketMeta } from "../types.js";

interface GammaMarketResponse {
  conditionId: string;
  question: string;
  slug: string;
  eventSlug?: string;
}

interface GammaEventResponse {
  slug: string;
  title: string;
  markets?: GammaMarketResponse[];
}

export async function fetchMarketByConditionId(
  conditionId: string,
  slug?: string
): Promise<MarketMeta | null> {
  // Try condition_ids lookup first
  const marketsUrl = `https://gamma-api.polymarket.com/markets?condition_ids=${conditionId}`;
  const marketsRes = await fetch(marketsUrl);

  if (marketsRes.ok) {
    const data = (await marketsRes.json()) as GammaMarketResponse[];
    if (Array.isArray(data) && data.length > 0) {
      const market = data[0];
      return {
        conditionId: market.conditionId,
        title: market.question,
        slug: market.slug,
        eventSlug: market.eventSlug ?? null,
      };
    }
  }

  // Fallback: try events endpoint with slug from the trade
  if (slug) {
    const eventsUrl = `https://gamma-api.polymarket.com/events?slug=${slug}`;
    const eventsRes = await fetch(eventsUrl);

    if (eventsRes.ok) {
      const events = (await eventsRes.json()) as GammaEventResponse[];
      if (Array.isArray(events) && events.length > 0) {
        const event = events[0];
        return {
          conditionId,
          title: event.title,
          slug: event.slug,
          eventSlug: event.slug,
        };
      }
    }
  }

  console.error(`Gamma API returned no results for ${conditionId}`);
  return null;
}
