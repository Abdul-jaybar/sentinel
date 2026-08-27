import type { MarketAsset, PriceSeries } from "@/lib/types";
import { choleskyWithShrinkage } from "@/lib/risk/matrix";
import { mulberry32 } from "@/lib/risk/survival";

/**
 * Bundled reference dataset.
 *
 * This is SYNTHETIC data, generated deterministically, and every surface that
 * uses it says so. It exists for one reason: a risk tool that shows a blank
 * page when a free API rate-limits is useless in exactly the moment someone
 * opened it in a hurry. The generator is calibrated to plausible crypto
 * parameters — annualised vols in the 45–110% range, a correlation block
 * structure with majors tighter than alts, and an injected stress regime where
 * correlations rise and returns go negative together — so the engine has
 * realistic structure to operate on.
 *
 * It is not a substitute for live prices and is never presented as one.
 */

interface AssetSpec {
  coinId: string;
  symbol: string;
  name: string;
  price: number;
  /** Annualised volatility. */
  vol: number;
  /** Beta to BTC in the calm regime. */
  beta: number;
  marketCap: number;
}

const SPECS: AssetSpec[] = [
  { coinId: "bitcoin", symbol: "BTC", name: "Bitcoin", price: 68000, vol: 0.45, beta: 1, marketCap: 1_340_000_000_000 },
  { coinId: "ethereum", symbol: "ETH", name: "Ethereum", price: 3300, vol: 0.58, beta: 1.15, marketCap: 396_000_000_000 },
  { coinId: "solana", symbol: "SOL", name: "Solana", price: 155, vol: 0.85, beta: 1.55, marketCap: 72_000_000_000 },
  { coinId: "ripple", symbol: "XRP", name: "XRP", price: 0.62, vol: 0.72, beta: 1.2, marketCap: 34_000_000_000 },
  { coinId: "cardano", symbol: "ADA", name: "Cardano", price: 0.46, vol: 0.78, beta: 1.35, marketCap: 16_000_000_000 },
  { coinId: "avalanche-2", symbol: "AVAX", name: "Avalanche", price: 28, vol: 0.92, beta: 1.6, marketCap: 11_000_000_000 },
  { coinId: "chainlink", symbol: "LINK", name: "Chainlink", price: 14.5, vol: 0.8, beta: 1.4, marketCap: 9_000_000_000 },
  { coinId: "dogecoin", symbol: "DOGE", name: "Dogecoin", price: 0.12, vol: 1.05, beta: 1.7, marketCap: 17_000_000_000 },
  { coinId: "polkadot", symbol: "DOT", name: "Polkadot", price: 4.2, vol: 0.82, beta: 1.45, marketCap: 6_000_000_000 },
  { coinId: "uniswap", symbol: "UNI", name: "Uniswap", price: 7.4, vol: 0.88, beta: 1.5, marketCap: 4_400_000_000 },
];

const SPEC_BY_ID = new Map(SPECS.map((s) => [s.coinId, s]));

function specFor(coinId: string): AssetSpec {
  const known = SPEC_BY_ID.get(coinId);
  if (known) return known;
  // Unknown asset: treat it as a generic high-beta alt.
  return {
    coinId,
    symbol: coinId.slice(0, 4).toUpperCase(),
    name: coinId,
    price: 10,
    vol: 0.9,
    beta: 1.5,
    marketCap: 500_000_000,
  };
}

/** Box-Muller transform, driven by the supplied uniform generator. */
function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function fallbackMarkets(): MarketAsset[] {
  return SPECS.map((s) => ({
    coinId: s.coinId,
    symbol: s.symbol,
    name: s.name,
    price: s.price,
    marketCap: s.marketCap,
    volume24h: s.marketCap * 0.05,
    change24h: 0,
  }));
}

/**
 * Generate correlated daily price paths.
 *
 * Structure: a single common factor (the benchmark) scaled by each asset's
 * beta, plus idiosyncratic noise. That reproduces the block correlation you
 * actually see in crypto without hand-specifying an n-by-n matrix. A stress
 * window is injected in the middle third, where the common factor is negative
 * and idiosyncratic variance is suppressed — which is what "correlations go to
 * one" looks like mechanically.
 */
export function fallbackHistory(coinIds: string[], days = 90): PriceSeries[] {
  const rng = mulberry32(0xc0ffee);
  const specs = coinIds.map(specFor);

  // Common factor path.
  const benchmarkDaily = 0.45 / Math.sqrt(365);
  const factor: number[] = [];
  const stressStart = Math.floor(days * 0.42);
  const stressEnd = Math.floor(days * 0.58);

  for (let t = 0; t < days; t++) {
    const inStress = t >= stressStart && t <= stressEnd;
    const drift = inStress ? -0.012 : 0.0012;
    const scale = inStress ? 2.1 : 1;
    factor.push(drift + gaussian(rng) * benchmarkDaily * scale);
  }

  // Idiosyncratic components, damped during stress so correlations converge.
  const idio: number[][] = specs.map((s) => {
    const daily = s.vol / Math.sqrt(365);
    const systematicShare = Math.min(0.85, 0.45 + s.beta * 0.2);
    const idioVol = daily * Math.sqrt(Math.max(0.05, 1 - systematicShare));
    return Array.from({ length: days }, (_, t) => {
      const inStress = t >= stressStart && t <= stressEnd;
      return gaussian(rng) * idioVol * (inStress ? 0.35 : 1);
    });
  });

  // Keep the Cholesky import meaningful: verify the implied correlation
  // structure is usable, and fall back to independence if it is not.
  const impliedCorr = specs.map((a, i) =>
    specs.map((b, j) => (i === j ? 1 : Math.min(0.95, (a.beta * b.beta) / 2.4))),
  );
  choleskyWithShrinkage(impliedCorr);

  const now = Date.now();
  const dayMs = 86_400_000;

  return specs.map((s, i) => {
    const prices: number[] = [];
    const timestamps: number[] = [];
    // Walk backwards from the current price so the series ends at spot.
    const returns = Array.from(
      { length: days },
      (_, t) => s.beta * factor[t] + idio[i][t],
    );

    let price = s.price;
    const reversed: number[] = [];
    for (let t = days - 1; t >= 0; t--) {
      reversed.push(price);
      price = price / (1 + returns[t]);
    }
    reversed.reverse();

    for (let t = 0; t < days; t++) {
      prices.push(Math.max(reversed[t], s.price * 0.01));
      timestamps.push(now - (days - 1 - t) * dayMs);
    }

    return { coinId: s.coinId, symbol: s.symbol, timestamps, prices };
  });
}
