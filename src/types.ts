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
  outcome: string;         // "Yes" | "No"
  transactionHash: string;
}
