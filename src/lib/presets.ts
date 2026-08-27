import type { Position } from "@/lib/types";

export interface Preset {
  id: string;
  name: string;
  thesis: string;
  positions: Omit<Position, "id">[];
}

/**
 * Preset books, chosen to demonstrate specific failure modes rather than to
 * look impressive. Someone opening this for the first time should be able to
 * see the tool find something non-obvious within one click.
 */
export const PRESETS: Preset[] = [
  {
    id: "alt-beta",
    name: "The diversified alt book",
    thesis:
      "Six different tickers, four different narratives, one actual bet. Watch effective independent bets collapse toward 1 in the stressed regime.",
    positions: [
      { coinId: "solana", symbol: "SOL", quantity: 65, entryPrice: 152, leverage: 3, venue: "perp" },
      { coinId: "avalanche-2", symbol: "AVAX", quantity: 320, entryPrice: 29, leverage: 3, venue: "perp" },
      { coinId: "chainlink", symbol: "LINK", quantity: 620, entryPrice: 14.8, leverage: 2, venue: "perp" },
      { coinId: "polkadot", symbol: "DOT", quantity: 2100, entryPrice: 4.3, leverage: 2, venue: "perp" },
      { coinId: "uniswap", symbol: "UNI", quantity: 1200, entryPrice: 7.6, leverage: 2, venue: "perp" },
      { coinId: "cardano", symbol: "ADA", quantity: 19000, entryPrice: 0.47, leverage: 2, venue: "perp" },
    ],
  },
  {
    id: "levered-major",
    name: "Levered majors",
    thesis:
      "BTC and ETH at 5x. Individually each liquidation level looks survivable. The cascade chart shows they are not independent.",
    positions: [
      { coinId: "bitcoin", symbol: "BTC", quantity: 0.75, entryPrice: 67500, leverage: 5, venue: "perp" },
      { coinId: "ethereum", symbol: "ETH", quantity: 12, entryPrice: 3280, leverage: 5, venue: "perp" },
      { coinId: "solana", symbol: "SOL", quantity: 90, entryPrice: 158, leverage: 4, venue: "perp" },
    ],
  },
  {
    id: "hedged",
    name: "Long alts / short BTC",
    thesis:
      "A book that believes it is market-neutral. Component expected shortfall shows where the residual risk actually sits.",
    positions: [
      { coinId: "solana", symbol: "SOL", quantity: 120, entryPrice: 154, leverage: 3, venue: "perp" },
      { coinId: "chainlink", symbol: "LINK", quantity: 900, entryPrice: 14.6, leverage: 3, venue: "perp" },
      { coinId: "bitcoin", symbol: "BTC", quantity: -0.6, entryPrice: 68200, leverage: 3, venue: "perp" },
    ],
  },
  {
    id: "spot-hodl",
    name: "Unlevered spot",
    thesis:
      "No leverage anywhere. Nothing can be liquidated — but the drawdown and expected-shortfall numbers still have plenty to say.",
    positions: [
      { coinId: "bitcoin", symbol: "BTC", quantity: 0.4, entryPrice: 61000, leverage: 1, venue: "spot" },
      { coinId: "ethereum", symbol: "ETH", quantity: 6, entryPrice: 2950, leverage: 1, venue: "spot" },
      { coinId: "solana", symbol: "SOL", quantity: 45, entryPrice: 130, leverage: 1, venue: "spot" },
    ],
  },
];

export function instantiate(preset: Preset): Position[] {
  return preset.positions.map((p, i) => ({
    ...p,
    id: `${preset.id}-${i}-${Math.random().toString(36).slice(2, 8)}`,
  }));
}
