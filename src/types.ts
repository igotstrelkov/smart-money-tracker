// Shared TypeScript types for the smart-money tracker.
// These represent the subset of Polymarket API fields we actually use.

export interface Trade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;           // token id (string, very long number)
  conditionId: string;     // 0x... market identifier
  size: number;            // shares
  price: number;           // 0..1
  timestamp: number;       // unix seconds
  title: string;
  slug: string;
  eventSlug: string;       // event-level slug for URL construction
  outcome: string;         // "Yes" | "No"
  transactionHash: string;
}

export interface MarketMeta {
  conditionId: string;
  title: string;
  slug: string;
  eventSlug: string | null;
}

export interface EnrichedTrade extends Trade {
  eventUrl: string;
  bestAsk: number | null;
  depthWithin2cUsd: number | null;
  slippage: number | null;
}

export interface ShadowPosition {
  transactionHash: string;
  leaderWallet: string;
  leaderName: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: string;
  leaderFillPrice: number;
  hypotheticalEntryPrice: number;
  hypotheticalSizeUsd: number;
  marketTitle: string;
  marketSlug: string;
  alertTimestamp: number;
  evaluationStatus: "open" | "resolved" | "unable_to_value";
  evaluatedAt: number | null;
  evaluatedValueUsd: number | null;
  evaluatedPnlUsd: number | null;
}
