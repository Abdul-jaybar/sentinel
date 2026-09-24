import type { PricedPosition } from "@/lib/types";

export interface LadderRung {
  /** Benchmark (BTC) move, e.g. -0.15 */
  benchmarkMove: number;
  /** Account equity remaining, USD. */
  equity: number;
  /** equity / startingEquity */
  equityPct: number;
  liquidatedCount: number;
  newlyLiquidated: string[];
}

export interface CascadePoint {
  benchmarkMove: number;
  symbols: string[];
  equityPctAfter: number;
  /** How much of the book, by notional, dies at this rung. */
  notionalLost: number;
}

export interface CascadeReport {
  ladder: LadderRung[];
  points: CascadePoint[];
  /** Benchmark move at which account equity is fully gone. Null if never. */
  wipeoutMove: number | null;
  /** Benchmark move that triggers the first liquidation. Null if unlevered. */
  firstLiquidationMove: number | null;
  /**
   * Largest number of positions liquidated by a single rung. This is the clustering
   * that a per-position liquidation price simply cannot show you.
   */
  largestSimultaneousLiquidation: number;
  hasLeverage: boolean;
}

export function defaultMaintenanceMarginRate(leverage: number): number {
  // Roughly mirrors major perp venue tiers: tighter maintenance at high
  // leverage. Deliberately conservative rather than venue-exact.
  if (leverage >= 50) return 0.004;
  if (leverage >= 20) return 0.005;
  if (leverage >= 10) return 0.0075;
  if (leverage >= 5) return 0.01;
  return 0.005;
}

/**
 * Price at which a levered position is force-closed.
 *
 * For a long:  entry * (1 - 1/L + mmr)
 * For a short: entry * (1 + 1/L - mmr)
 *
 * Isolated-margin convention: each position carries its own margin and dies on
 * its own, which is the common retail setup and the conservative assumption
 * for cascade analysis.
 */
export function liquidationPrice(position: PricedPosition): number | null {
  if (position.leverage <= 1) return null;
  const mmr =
    position.maintenanceMarginRate ??
    defaultMaintenanceMarginRate(position.leverage);
  const isLong = position.quantity > 0;
  const factor = isLong
    ? 1 - 1 / position.leverage + mmr
    : 1 + 1 / position.leverage - mmr;
  return position.entryPrice * factor;
}

/**
 * Walk the benchmark down and record what breaks, in order.
 *
 * Each asset is moved by its own beta to the benchmark rather than by the same
 * percentage, because that is how a real sell-off propagates: high-beta alts
 * fall further than BTC, so they hit their liquidation levels first even when
 * their nominal leverage looks identical.
 *
 * The output is the chart that makes the risk legible: not "your liquidation
 * price is $X" per position, but "at -18% you lose two positions at once, and
 * the margin freed up is not enough to hold the rest".
 */
export function buildCascade(
  positions: PricedPosition[],
  betas: Record<string, number>,
  startingEquity: number,
  maxDown = 0.6,
  step = 0.005,
): CascadeReport {
  const hasLeverage = positions.some((p) => p.leverage > 1);
  const ladder: LadderRung[] = [];
  const points: CascadePoint[] = [];

  const dead = new Set<string>();
  let firstLiquidationMove: number | null = null;
  let wipeoutMove: number | null = null;
  let largestSimultaneousLiquidation = 0;

  const steps = Math.round(maxDown / step);

  for (let s = 0; s <= steps; s++) {
    const move = -s * step;
    const newlyLiquidated: string[] = [];
    let notionalLost = 0;
    let equity = 0;

    for (const p of positions) {
      const beta = betas[p.coinId] ?? 1;
      const shockedPrice = p.price * (1 + beta * move);
      const pnl = p.quantity * (shockedPrice - p.entryPrice);
      const positionEquity = p.initialMargin + pnl;

      if (p.leverage > 1) {
        const mmr =
          p.maintenanceMarginRate ?? defaultMaintenanceMarginRate(p.leverage);
        const maintenance = Math.abs(p.quantity * shockedPrice) * mmr;
        if (positionEquity <= maintenance) {
          if (!dead.has(p.id)) {
            dead.add(p.id);
            newlyLiquidated.push(p.symbol);
            notionalLost += Math.abs(p.notional);
          }
          // A liquidated isolated-margin position contributes nothing further.
          continue;
        }
      }

      equity += dead.has(p.id) ? 0 : positionEquity;
    }

    const equityPct = startingEquity > 0 ? equity / startingEquity : 0;

    if (newlyLiquidated.length > 0) {
      if (firstLiquidationMove === null) firstLiquidationMove = move;
      largestSimultaneousLiquidation = Math.max(
        largestSimultaneousLiquidation,
        newlyLiquidated.length,
      );
      points.push({
        benchmarkMove: move,
        symbols: newlyLiquidated,
        equityPctAfter: equityPct,
        notionalLost,
      });
    }

    if (wipeoutMove === null && equity <= 0) wipeoutMove = move;

    ladder.push({
      benchmarkMove: move,
      equity,
      equityPct,
      liquidatedCount: dead.size,
      newlyLiquidated,
    });
  }

  return {
    ladder,
    points,
    wipeoutMove,
    firstLiquidationMove,
    largestSimultaneousLiquidation,
    hasLeverage,
  };
}
