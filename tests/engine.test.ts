import { describe, expect, it } from "vitest";
import type { Position, PriceSeries } from "@/lib/types";
import { buildReport, pricePositions } from "@/lib/risk/engine";
import { alignSeries, portfolioPnlSeries, simpleReturns } from "@/lib/risk/returns";
import { effectiveBets } from "@/lib/risk/regime";
import { buildCascade, liquidationPrice } from "@/lib/risk/cascade";
import { computeVar } from "@/lib/risk/var";
import { symmetricEigenvalues } from "@/lib/risk/matrix";
import { simulateSurvival, mulberry32 } from "@/lib/risk/survival";
import { runStressTests, type Scenario } from "@/lib/risk/stress";

const DAY = 86_400_000;

function series(coinId: string, symbol: string, prices: number[]): PriceSeries {
  const start = Date.UTC(2025, 0, 1);
  return {
    coinId,
    symbol,
    timestamps: prices.map((_, i) => start + i * DAY),
    prices,
  };
}

/** Deterministic correlated price paths, for tests that need real structure. */
function syntheticSeries(
  coinId: string,
  symbol: string,
  n: number,
  vol: number,
  beta: number,
  factor: number[],
  seed: number,
): PriceSeries {
  const rng = mulberry32(seed);
  let price = 100;
  const prices: number[] = [];
  for (let i = 0; i < n; i++) {
    const idio = (rng() - 0.5) * vol;
    price *= 1 + beta * factor[i] + idio;
    prices.push(price);
  }
  return series(coinId, symbol, prices);
}

describe("returns", () => {
  it("computes simple returns", () => {
    const r = simpleReturns([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 12);
    expect(r[1]).toBeCloseTo(-0.1, 12);
  });

  it("produces n-1 returns from n prices", () => {
    expect(simpleReturns([1, 2, 3, 4, 5])).toHaveLength(4);
  });
});

describe("alignSeries", () => {
  it("intersects onto a shared date axis", () => {
    const a = series("a", "A", [1, 2, 3, 4, 5]);
    const b = series("b", "B", [10, 20, 30, 40, 50]);
    const aligned = alignSeries([a, b]);
    expect(aligned.timestamps).toHaveLength(5);
    expect(aligned.returns.a).toHaveLength(4);
    expect(aligned.returns.b).toHaveLength(4);
  });

  it("drops an asset with insufficient overlapping history", () => {
    const a = series("a", "A", Array.from({ length: 40 }, (_, i) => 100 + i));
    const short: PriceSeries = {
      coinId: "b",
      symbol: "B",
      timestamps: [Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 2)],
      prices: [10, 11],
    };
    const aligned = alignSeries([a, short]);
    expect(aligned.dropped).toContain("b");
    expect(aligned.returns.b).toBeUndefined();
  });
});

describe("portfolio P&L", () => {
  it("is linear in notional", () => {
    const returns = [[0.1, -0.05], [0.02, 0.03]];
    const pnl = portfolioPnlSeries([1000, 2000], returns);
    expect(pnl[0]).toBeCloseTo(1000 * 0.1 + 2000 * 0.02, 10);
    expect(pnl[1]).toBeCloseTo(1000 * -0.05 + 2000 * 0.03, 10);
  });

  it("handles shorts as negative notional", () => {
    const pnl = portfolioPnlSeries([-1000], [[0.1]]);
    expect(pnl[0]).toBeCloseTo(-100, 10);
  });
});

describe("liquidation price", () => {
  it("returns null for unlevered positions", () => {
    const [p] = pricePositions(
      [
        {
          id: "1",
          coinId: "bitcoin",
          symbol: "BTC",
          quantity: 1,
          entryPrice: 100,
          leverage: 1,
          venue: "spot",
        },
      ],
      { bitcoin: 100 },
    );
    expect(liquidationPrice(p)).toBeNull();
  });

  it("puts a 5x long roughly 20% below entry", () => {
    const [p] = pricePositions(
      [
        {
          id: "1",
          coinId: "bitcoin",
          symbol: "BTC",
          quantity: 1,
          entryPrice: 100,
          leverage: 5,
          venue: "perp",
          maintenanceMarginRate: 0,
        },
      ],
      { bitcoin: 100 },
    );
    expect(liquidationPrice(p)).toBeCloseTo(80, 10);
  });

  it("puts a 5x short roughly 20% above entry", () => {
    const [p] = pricePositions(
      [
        {
          id: "1",
          coinId: "bitcoin",
          symbol: "BTC",
          quantity: -1,
          entryPrice: 100,
          leverage: 5,
          venue: "perp",
          maintenanceMarginRate: 0,
        },
      ],
      { bitcoin: 100 },
    );
    expect(liquidationPrice(p)).toBeCloseTo(120, 10);
  });
});

describe("VaR", () => {
  it("orders expected shortfall at or beyond VaR", () => {
    const pnl = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 1000 - i);
    const block = computeVar(pnl, [10000], [[0.0016]], 50_000, 0.99);
    expect(block.expectedShortfall).toBeGreaterThanOrEqual(block.historical - 1e-9);
  });

  it("is never negative", () => {
    const alwaysUp = Array.from({ length: 100 }, () => 500);
    const block = computeVar(alwaysUp, [10000], [[0.0001]], 50_000, 0.99);
    expect(block.historical).toBeGreaterThanOrEqual(0);
    expect(block.expectedShortfall).toBeGreaterThanOrEqual(0);
  });

  it("scales linearly with position size", () => {
    const pnl = Array.from({ length: 300 }, (_, i) => ((i * 37) % 101) - 50);
    const small = computeVar(pnl, [1000], [[0.001]], 10_000, 0.99);
    const doubled = computeVar(
      pnl.map((p) => p * 2),
      [2000],
      [[0.001]],
      10_000,
      0.99,
    );
    expect(doubled.historical).toBeCloseTo(small.historical * 2, 6);
  });
});

describe("effective bets", () => {
  it("equals n for a perfectly uncorrelated book", () => {
    const identity = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    expect(effectiveBets(identity)).toBeCloseTo(3, 6);
  });

  it("collapses toward 1 as correlations approach 1", () => {
    const nearlyOne = [
      [1, 0.99, 0.99],
      [0.99, 1, 0.99],
      [0.99, 0.99, 1],
    ];
    expect(effectiveBets(nearlyOne)).toBeLessThan(1.3);
  });

  it("sits between the extremes for a realistic matrix", () => {
    const realistic = [
      [1, 0.7, 0.6],
      [0.7, 1, 0.65],
      [0.6, 0.65, 1],
    ];
    const n = effectiveBets(realistic);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThan(3);
  });
});

describe("eigenvalues", () => {
  it("recovers the spectrum of a known symmetric matrix", () => {
    // [[2,1],[1,2]] has eigenvalues 3 and 1.
    const e = symmetricEigenvalues([
      [2, 1],
      [1, 2],
    ]);
    expect(e[0]).toBeCloseTo(3, 8);
    expect(e[1]).toBeCloseTo(1, 8);
  });

  it("preserves the trace", () => {
    const m = [
      [1, 0.5, 0.3],
      [0.5, 1, 0.4],
      [0.3, 0.4, 1],
    ];
    const sum = symmetricEigenvalues(m).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(3, 8);
  });
});

describe("cascade", () => {
  it("finds simultaneous liquidations for same-leverage, same-beta positions", () => {
    const positions = pricePositions(
      [
        { id: "1", coinId: "a", symbol: "A", quantity: 10, entryPrice: 100, leverage: 5, venue: "perp", maintenanceMarginRate: 0 },
        { id: "2", coinId: "b", symbol: "B", quantity: 20, entryPrice: 50, leverage: 5, venue: "perp", maintenanceMarginRate: 0 },
      ],
      { a: 100, b: 50 },
    );
    const equity = positions.reduce((acc, p) => acc + p.equity, 0);
    const cascade = buildCascade(positions, { a: 1, b: 1 }, equity);
    expect(cascade.largestSimultaneousLiquidation).toBe(2);
    expect(cascade.firstLiquidationMove).toBeLessThan(0);
    expect(cascade.firstLiquidationMove).toBeGreaterThan(-0.25);
  });

  it("reports no liquidations for an unlevered book", () => {
    const positions = pricePositions(
      [{ id: "1", coinId: "a", symbol: "A", quantity: 10, entryPrice: 100, leverage: 1, venue: "spot" }],
      { a: 100 },
    );
    const cascade = buildCascade(positions, { a: 1 }, 1000);
    expect(cascade.hasLeverage).toBe(false);
    expect(cascade.firstLiquidationMove).toBeNull();
  });

  it("liquidates a high-beta position before a low-beta one at equal leverage", () => {
    const positions = pricePositions(
      [
        { id: "1", coinId: "low", symbol: "LOW", quantity: 10, entryPrice: 100, leverage: 4, venue: "perp", maintenanceMarginRate: 0 },
        { id: "2", coinId: "high", symbol: "HIGH", quantity: 10, entryPrice: 100, leverage: 4, venue: "perp", maintenanceMarginRate: 0 },
      ],
      { low: 100, high: 100 },
    );
    const equity = positions.reduce((acc, p) => acc + p.equity, 0);
    const cascade = buildCascade(positions, { low: 0.8, high: 2 }, equity);
    expect(cascade.points[0].symbols).toEqual(["HIGH"]);
  });
});

describe("survival simulation", () => {
  const n = 120;
  const rngFactor = mulberry32(7);
  const factor = Array.from({ length: n }, () => (rngFactor() - 0.5) * 0.06);

  const seriesSet = [
    syntheticSeries("bitcoin", "BTC", n, 0.02, 1, factor, 11),
    syntheticSeries("ethereum", "ETH", n, 0.03, 1.2, factor, 12),
    syntheticSeries("solana", "SOL", n, 0.05, 1.6, factor, 13),
  ];

  const livePrices = Object.fromEntries(
    seriesSet.map((s) => [s.coinId, s.prices[s.prices.length - 1]]),
  );

  function positionsAt(leverage: number): Position[] {
    return seriesSet.map((s, i) => ({
      id: `p${i}`,
      coinId: s.coinId,
      symbol: s.symbol,
      quantity: 100 / s.prices[s.prices.length - 1],
      entryPrice: s.prices[s.prices.length - 1],
      leverage,
      venue: leverage > 1 ? ("perp" as const) : ("spot" as const),
    }));
  }

  it("is deterministic for identical input", () => {
    const priced = pricePositions(positionsAt(3), livePrices);
    const aligned = seriesSet.map((s) => simpleReturns(s.prices));
    const a = simulateSurvival(priced, aligned, { paths: 400 });
    const b = simulateSurvival(priced, aligned, { paths: 400 });
    expect(a.ruinProbability).toBe(b.ruinProbability);
    expect(a.medianTerminalEquityPct).toBe(b.medianTerminalEquityPct);
  });

  it("returns probabilities inside [0, 1]", () => {
    const priced = pricePositions(positionsAt(5), livePrices);
    const aligned = seriesSet.map((s) => simpleReturns(s.prices));
    const r = simulateSurvival(priced, aligned, { paths: 500 });
    for (const p of [
      r.ruinProbability,
      r.liquidationProbability,
      r.totalWipeoutProbability,
    ]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("finds more risk at higher leverage", () => {
    const aligned = seriesSet.map((s) => simpleReturns(s.prices));
    const low = simulateSurvival(pricePositions(positionsAt(2), livePrices), aligned, { paths: 800 });
    const high = simulateSurvival(pricePositions(positionsAt(10), livePrices), aligned, { paths: 800 });
    expect(high.ruinProbability).toBeGreaterThanOrEqual(low.ruinProbability);
    expect(high.liquidationProbability).toBeGreaterThan(low.liquidationProbability);
  });

  it("never liquidates an unlevered book", () => {
    const aligned = seriesSet.map((s) => simpleReturns(s.prices));
    const spot = simulateSurvival(pricePositions(positionsAt(1), livePrices), aligned, { paths: 500 });
    expect(spot.liquidationProbability).toBe(0);
  });

  it("produces a monotonically non-increasing survival curve", () => {
    const aligned = seriesSet.map((s) => simpleReturns(s.prices));
    const r = simulateSurvival(pricePositions(positionsAt(5), livePrices), aligned, { paths: 600 });
    for (let i = 1; i < r.curve.length; i++) {
      expect(r.curve[i].survival).toBeLessThanOrEqual(r.curve[i - 1].survival + 1e-9);
    }
  });
});

describe("buildReport end to end", () => {
  const n = 120;
  const rngFactor = mulberry32(99);
  const factor = Array.from({ length: n }, () => (rngFactor() - 0.5) * 0.07);
  const seriesSet = [
    syntheticSeries("bitcoin", "BTC", n, 0.02, 1, factor, 21),
    syntheticSeries("ethereum", "ETH", n, 0.03, 1.2, factor, 22),
    syntheticSeries("solana", "SOL", n, 0.05, 1.7, factor, 23),
  ];
  const livePrices = Object.fromEntries(
    seriesSet.map((s) => [s.coinId, s.prices[s.prices.length - 1]]),
  );
  const positions: Position[] = seriesSet.map((s, i) => ({
    id: `p${i}`,
    coinId: s.coinId,
    symbol: s.symbol,
    quantity: 5000 / s.prices[s.prices.length - 1],
    entryPrice: s.prices[s.prices.length - 1],
    leverage: 3,
    venue: "perp",
  }));

  const report = buildReport(positions, seriesSet, livePrices, "live", {
    paths: 500,
    skipPrescription: true,
  });

  it("produces a complete report with no NaNs in the headline figures", () => {
    const headline = [
      report.exposure.equity,
      report.exposure.leverageRatio,
      report.var99.historical,
      report.var99.expectedShortfall,
      report.survival.ruinProbability,
      report.regimes.avgStressed,
      report.performance.maxDrawdown,
      report.concentration.hhi,
    ];
    for (const v of headline) expect(Number.isFinite(v)).toBe(true);
  });

  it("decomposes expected shortfall so components sum to the total", () => {
    const sum = report.contributions.reduce((acc, c) => acc + c.componentES, 0);
    expect(sum).toBeCloseTo(report.var95.expectedShortfall, 6);
  });

  it("gives every contribution an ES share summing to 1", () => {
    const total = report.contributions.reduce((acc, c) => acc + c.esShare, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("computes gross exposure as the sum of absolute notionals", () => {
    const expected = report.positions.reduce(
      (acc, p) => acc + Math.abs(p.notional),
      0,
    );
    expect(report.exposure.grossExposure).toBeCloseTo(expected, 6);
  });

  it("keeps the correlation matrix symmetric with a unit diagonal", () => {
    const { matrix, symbols } = report.correlationMatrix;
    for (let i = 0; i < symbols.length; i++) {
      expect(matrix[i][i]).toBeCloseTo(1, 10);
      for (let j = 0; j < symbols.length; j++) {
        expect(matrix[i][j]).toBeCloseTo(matrix[j][i], 12);
      }
    }
  });

  it("runs every stress scenario and caps isolated-margin losses", () => {
    expect(report.stress.length).toBeGreaterThan(4);
    for (const s of report.stress) {
      expect(Number.isFinite(s.pnl)).toBe(true);
      // Cannot lose more than the equity that was posted.
      expect(s.pnl).toBeGreaterThanOrEqual(-report.exposure.equity - 1e-6);
    }
  });

  it("emits alerts that all carry a rule id and a threshold", () => {
    for (const a of report.alerts) {
      expect(a.rule.length).toBeGreaterThan(0);
      expect(Number.isFinite(a.value)).toBe(true);
      expect(Number.isFinite(a.threshold)).toBe(true);
    }
  });
});

describe("degenerate input", () => {
  it("survives a single-position portfolio", () => {
    const s = series("bitcoin", "BTC", Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5));
    const report = buildReport(
      [{ id: "1", coinId: "bitcoin", symbol: "BTC", quantity: 1, entryPrice: 100, leverage: 1, venue: "spot" }],
      [s],
      { bitcoin: 100 },
      "live",
      { paths: 200, skipPrescription: true },
    );
    expect(report.positions).toHaveLength(1);
    expect(Number.isFinite(report.var99.historical)).toBe(true);
    expect(report.regimes.symbols).toHaveLength(1);
  });

  it("returns an empty report rather than throwing when no series match", () => {
    const report = buildReport(
      [{ id: "1", coinId: "unknown", symbol: "UNK", quantity: 1, entryPrice: 100, leverage: 1, venue: "spot" }],
      [],
      {},
      "fallback",
      { paths: 100, skipPrescription: true },
    );
    expect(report.positions).toHaveLength(0);
    expect(Number.isFinite(report.exposure.equity)).toBe(true);
  });
});

describe("stress tests", () => {
  it("never books a liquidation as a gain, even when the position is already underwater", () => {
    // A 3x short opened at 100 with the price now at 200 has already lost more
    // than its margin. A rally liquidates it, and that must cost nothing
    // further rather than hand back the missing equity as profit.
    const rally: Scenario = {
      id: "rally",
      name: "rally",
      description: "",
      benchmarkShock: 0.5,
      betaAmplifier: 1,
      provenance: "assumed",
      window: null,
    };
    const priced = pricePositions(
      [{ id: "1", coinId: "bitcoin", symbol: "BTC", quantity: -1, entryPrice: 100, leverage: 3, venue: "perp" }],
      { bitcoin: 200 },
    );
    const [result] = runStressTests(priced, { bitcoin: 1 }, 100, [rally]);
    expect(result.liquidated).toEqual(["BTC"]);
    expect(result.pnl).toBe(0);
  });
});
