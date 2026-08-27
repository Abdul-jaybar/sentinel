import type { PricedPosition } from "@/lib/types";
import { defaultMaintenanceMarginRate } from "./cascade";
import { quantile } from "./stats";

export interface SurvivalPoint {
  day: number;
  /** P(account has not breached the ruin threshold by this day). */
  survival: number;
  /** Equity percentiles across all paths, as a fraction of starting equity. */
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface SurvivalReport {
  horizonDays: number;
  paths: number;
  /** Drawdown that counts as ruin, e.g. 0.5 = losing half the account. */
  ruinThreshold: number;
  ruinProbability: number;
  /** P(at least one position is force-closed within the horizon). */
  liquidationProbability: number;
  /** P(the whole book is force-closed within the horizon). */
  totalWipeoutProbability: number;
  /** Median days to ruin, across the paths that actually ruin. */
  medianDaysToRuin: number | null;
  /** Expected worst drawdown along the path, not just at the end. */
  expectedMaxDrawdown: number;
  medianTerminalEquityPct: number;
  curve: SurvivalPoint[];
  /** Correlation shrinkage applied if the sample matrix was degenerate. */
  method: "block-bootstrap";
  blockLength: number;
}

/** Deterministic PRNG so the same portfolio always yields the same report. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of the portfolio, used as the simulation seed. */
export function seedFromPositions(positions: PricedPosition[]): number {
  const key = positions
    .map((p) => `${p.coinId}:${p.quantity}:${p.leverage}:${p.entryPrice}`)
    .join("|");
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Monte Carlo survival analysis via stationary block bootstrap.
 *
 * Why block bootstrap rather than a Gaussian / Cholesky simulation:
 *
 *  1. It resamples whole *days* across all assets at once, so the joint
 *     dependence structure is preserved exactly as it was realised — including
 *     the tail dependence that a correlation matrix throws away.
 *  2. Sampling contiguous blocks preserves volatility clustering. Crypto
 *     drawdowns are consecutive bad days, not independent draws, and it is the
 *     consecutive part that liquidates leveraged accounts.
 *  3. It cannot produce returns the market has never produced, which keeps the
 *     output defensible. The cost is that it cannot produce genuinely
 *     unprecedented ones either — stated plainly in the UI.
 *
 * Block lengths are geometric with mean `blockLength` (Politis & Romano's
 * stationary bootstrap), which avoids the edge artefacts of fixed blocks.
 */
export function simulateSurvival(
  positions: PricedPosition[],
  returnMatrix: number[][],
  options: {
    horizonDays?: number;
    paths?: number;
    ruinThreshold?: number;
    blockLength?: number;
  } = {},
): SurvivalReport {
  const horizonDays = options.horizonDays ?? 30;
  const paths = options.paths ?? 2000;
  const ruinThreshold = options.ruinThreshold ?? 0.5;
  const blockLength = options.blockLength ?? 5;

  const nAssets = positions.length;
  const nDays = returnMatrix[0]?.length ?? 0;

  const startingEquity = positions.reduce((acc, p) => acc + p.equity, 0);

  const emptyCurve: SurvivalPoint[] = Array.from(
    { length: horizonDays + 1 },
    (_, day) => ({ day, survival: 1, p05: 1, p25: 1, p50: 1, p75: 1, p95: 1 }),
  );

  if (nAssets === 0 || nDays < 20 || startingEquity <= 0) {
    return {
      horizonDays,
      paths: 0,
      ruinThreshold,
      ruinProbability: 0,
      liquidationProbability: 0,
      totalWipeoutProbability: 0,
      medianDaysToRuin: null,
      expectedMaxDrawdown: 0,
      medianTerminalEquityPct: 1,
      curve: emptyCurve,
      method: "block-bootstrap",
      blockLength,
    };
  }

  const rng = mulberry32(seedFromPositions(positions));
  const restartProb = 1 / blockLength;

  // equityByDay[day] = equity fraction across all paths, for percentiles.
  const equityByDay: number[][] = Array.from(
    { length: horizonDays + 1 },
    () => [],
  );
  const ruinedByDay = new Array<number>(horizonDays + 1).fill(0);

  let ruinCount = 0;
  let liquidationCount = 0;
  let wipeoutCount = 0;
  let maxDrawdownSum = 0;
  const daysToRuin: number[] = [];
  const terminalEquity: number[] = [];

  const mmrs = positions.map(
    (p) => p.maintenanceMarginRate ?? defaultMaintenanceMarginRate(p.leverage),
  );

  for (let path = 0; path < paths; path++) {
    const prices = positions.map((p) => p.price);
    const alive = positions.map(() => true);
    let cursor = Math.floor(rng() * nDays);

    let ruinedOnDay: number | null = null;
    let peak = 1;
    let maxDd = 0;
    let liquidatedAny = false;

    equityByDay[0].push(1);

    for (let day = 1; day <= horizonDays; day++) {
      // Stationary bootstrap: continue the block or jump to a new start.
      if (rng() < restartProb) cursor = Math.floor(rng() * nDays);
      else cursor = (cursor + 1) % nDays;

      for (let i = 0; i < nAssets; i++) {
        if (!alive[i]) continue;
        const r = returnMatrix[i]?.[cursor] ?? 0;
        prices[i] = prices[i] * (1 + r);
      }

      let equity = 0;
      for (let i = 0; i < nAssets; i++) {
        if (!alive[i]) continue;
        const p = positions[i];
        const pnl = p.quantity * (prices[i] - p.entryPrice);
        const positionEquity = p.initialMargin + pnl;

        if (p.leverage > 1) {
          const maintenance = Math.abs(p.quantity * prices[i]) * mmrs[i];
          if (positionEquity <= maintenance) {
            alive[i] = false;
            liquidatedAny = true;
            continue;
          }
        } else if (positionEquity <= 0) {
          alive[i] = false;
          continue;
        }
        equity += positionEquity;
      }

      const equityPct = equity / startingEquity;
      equityByDay[day].push(equityPct);

      peak = Math.max(peak, equityPct);
      maxDd = Math.max(maxDd, peak > 0 ? 1 - equityPct / peak : 0);

      if (ruinedOnDay === null && equityPct <= 1 - ruinThreshold) {
        ruinedOnDay = day;
      }
      if (ruinedOnDay !== null) ruinedByDay[day] += 1;

      if (day === horizonDays) {
        terminalEquity.push(equityPct);
        if (!alive.some(Boolean)) wipeoutCount += 1;
      }
    }

    if (ruinedOnDay !== null) {
      ruinCount += 1;
      daysToRuin.push(ruinedOnDay);
    }
    if (liquidatedAny) liquidationCount += 1;
    maxDrawdownSum += maxDd;
  }

  const curve: SurvivalPoint[] = equityByDay.map((values, day) => ({
    day,
    survival: 1 - ruinedByDay[day] / paths,
    p05: quantile(values, 0.05),
    p25: quantile(values, 0.25),
    p50: quantile(values, 0.5),
    p75: quantile(values, 0.75),
    p95: quantile(values, 0.95),
  }));

  return {
    horizonDays,
    paths,
    ruinThreshold,
    ruinProbability: ruinCount / paths,
    liquidationProbability: liquidationCount / paths,
    totalWipeoutProbability: wipeoutCount / paths,
    medianDaysToRuin:
      daysToRuin.length > 0 ? quantile(daysToRuin, 0.5) : null,
    expectedMaxDrawdown: maxDrawdownSum / paths,
    medianTerminalEquityPct: quantile(terminalEquity, 0.5),
    curve,
    method: "block-bootstrap",
    blockLength,
  };
}
