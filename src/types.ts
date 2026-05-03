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
  bestBid: number | null;
  depthWithin2cUsd: number | null;
  slippage: number | null;
}

export interface Alert {
  transactionHash: string;
  leaderWallet: string;
  leaderName: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: "BUY" | "SELL";
  leaderFillPrice: number;
  marketTitle: string;
  marketSlug: string;
  alertTimestamp: number;
  hypotheticalPrice?: number;
  hypotheticalSizeUsd?: number;
  evaluationStatus?: "open" | "closed_by_sell" | "resolved" | "unable_to_value";
  evaluatedAt?: number;
  evaluatedValueUsd?: number;
  evaluatedPnlUsd?: number;
}
