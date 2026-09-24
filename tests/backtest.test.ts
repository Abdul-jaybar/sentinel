import { describe, expect, it } from "vitest";
import type { PricedPosition } from "@/lib/types";
import {
  backtestVar,
  calibrateSurvival,
  chiSquareUpperTail,
  christoffersenIndependence,
  kupiecTest,
  realisedRuin,
  runBacktest,
} from "@/lib/risk/backtest";
import { mulberry32 } from "@/lib/risk/survival";

/**
 * Known-answer tests.
 *
 * Every expected value below comes from a published table or a closed form
 * derived by hand, never from running this code and pasting the output, which
 * would only prove the code is consistent with itself.
 */

describe("chi-squared upper tail", () => {
  // Standard critical values, e.g. any statistical tables appendix.
  it("matches published chi2(1) critical values", () => {
    expect(chiSquareUpperTail(2.706, 1)).toBeCloseTo(0.1, 3);
    expect(chiSquareUpperTail(3.841, 1)).toBeCloseTo(0.05, 3);
    expect(chiSquareUpperTail(6.635, 1)).toBeCloseTo(0.01, 3);
    expect(chiSquareUpperTail(10.828, 1)).toBeCloseTo(0.001, 4);
  });

  it("matches published chi2(2) critical values", () => {
    expect(chiSquareUpperTail(4.605, 2)).toBeCloseTo(0.1, 3);
    expect(chiSquareUpperTail(5.991, 2)).toBeCloseTo(0.05, 3);
    expect(chiSquareUpperTail(9.21, 2)).toBeCloseTo(0.01, 3);
  });

  it("returns 1 at or below zero", () => {
    expect(chiSquareUpperTail(0, 1)).toBe(1);
    expect(chiSquareUpperTail(-3, 2)).toBe(1);
  });

  it("is monotonically decreasing", () => {
    for (const df of [1, 2] as const) {
      let prev = 1;
      for (let x = 0.5; x < 20; x += 0.5) {
        const p = chiSquareUpperTail(x, df);
        expect(p).toBeLessThanOrEqual(prev);
        prev = p;
      }
    }
  });
});

describe("Kupiec proportion-of-failures test", () => {
  it("gives a likelihood ratio of exactly zero when the rate is perfect", () => {
    expect(kupiecTest(50, 1000, 0.05).lr).toBeCloseTo(0, 10);
    expect(kupiecTest(10, 1000, 0.01).lr).toBeCloseTo(0, 10);
  });

  it("matches the closed form when there are no exceptions at all", () => {
    // With x = 0 the statistic collapses to -2 * n * ln(1 - p).
    const n = 250;
    const p = 0.05;
    expect(kupiecTest(0, n, p).lr).toBeCloseTo(-2 * n * Math.log(1 - p), 8);
  });

  it("rejects a doubled exception rate at 1%", () => {
    const { pValue } = kupiecTest(25, 250, 0.05);
    expect(pValue).toBeLessThan(0.01);
  });

  it("does not reject a rate close to nominal", () => {
    expect(kupiecTest(13, 250, 0.05).pValue).toBeGreaterThan(0.05);
  });

  it("is symmetric in direction: too few exceptions also rejects", () => {
    expect(kupiecTest(1, 500, 0.05).pValue).toBeLessThan(0.01);
  });

  it("returns a neutral result for an empty sample", () => {
    expect(kupiecTest(0, 0, 0.05)).toEqual({ lr: 0, pValue: 1 });
  });
});

describe("Christoffersen independence test", () => {
  it("does not reject evenly spaced exceptions", () => {
    const hits = Array.from({ length: 400 }, (_, i) => i % 20 === 0);
    expect(christoffersenIndependence(hits).pValue).toBeGreaterThan(0.05);
  });

  it("strongly rejects a single contiguous cluster", () => {
    const hits = Array.from({ length: 400 }, (_, i) => i >= 100 && i < 120);
    const { lr, pValue } = christoffersenIndependence(hits);
    expect(lr).toBeGreaterThan(20);
    expect(pValue).toBeLessThan(0.001);
  });

  it("counts transitions correctly", () => {
    //        F  T  T  F  F  T
    // pairs: FT TT TF FF FT  ->  n01=2, n11=1, n10=1, n00=1
    const { transitions } = christoffersenIndependence([
      false,
      true,
      true,
      false,
      false,
      true,
    ]);
    expect(transitions).toEqual({ n00: 1, n01: 2, n10: 1, n11: 1 });
  });

  it("is neutral when no exception ever occurs", () => {
    const hits = new Array(200).fill(false);
    expect(christoffersenIndependence(hits).lr).toBeCloseTo(0, 10);
  });
});

/* ------------------------------------------------------------------ */

function position(overrides: Partial<PricedPosition> = {}): PricedPosition {
  const base: PricedPosition = {
    id: "p1",
    coinId: "bitcoin",
    symbol: "BTC",
    quantity: 1,
    entryPrice: 100,
    leverage: 1,
    venue: "spot",
    price: 100,
    notional: 100,
    initialMargin: 100,
    unrealizedPnl: 0,
    equity: 100,
    weight: 1,
  };
  return { ...base, ...overrides };
}

/** A long return series with a known, stable volatility. */
function returnsWithVol(n: number, dailyVol: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // Box-Muller
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * dailyVol);
  }
  return out;
}

describe("VaR backtest", () => {
  it("produces roughly the nominal exception rate on stationary data", () => {
    const returns = [returnsWithVol(900, 0.02, 7)];
    const tests = backtestVar([position()], returns, {
      confidence: 0.95,
      trainWindow: 250,
    });

    for (const t of tests) {
      expect(t.observations).toBe(650);
      // Well-specified model on stationary Gaussian data: the realised rate
      // should sit near 5%. A wide band, because 650 days is not many.
      expect(t.exceptionRate).toBeGreaterThan(0.02);
      expect(t.exceptionRate).toBeLessThan(0.09);
    }
  });

  it("reports no exceptions beyond the data when history is too short", () => {
    const tests = backtestVar([position()], [returnsWithVol(50, 0.02, 3)], {
      trainWindow: 120,
    });
    expect(tests.every((t) => t.observations === 0)).toBe(true);
    expect(tests[0].diagnosis).toContain("Not enough history");
  });

  it("counts an exception exactly when the loss exceeds the forecast", () => {
    // Every scored day here is deterministic: fourteen tiny gains, one
    // catastrophic loss, one more tiny gain. Only the crash can be an
    // exception, so the count is known exactly rather than probabilistically.
    const calm = returnsWithVol(315, 0.005, 11);
    const returns = [[...calm, ...new Array(14).fill(0.001), -0.5, 0.001]];
    const tests = backtestVar([position()], returns, {
      confidence: 0.99,
      trainWindow: 315,
    });
    for (const t of tests) {
      expect(t.observations).toBe(16);
      expect(t.exceptions).toBe(1);
      // The loss was many multiples of the forecast, which is the point.
      expect(t.meanExceedanceRatio).toBeGreaterThan(5);
      expect(t.maxConsecutiveExceptions).toBe(1);
    }
  });

  it("flags an under-estimating model when volatility regime-shifts up", () => {
    const calm = returnsWithVol(400, 0.004, 21);
    const violent = returnsWithVol(400, 0.05, 22);
    const tests = backtestVar([position()], [[...calm, ...violent]], {
      confidence: 0.95,
      trainWindow: 250,
    });
    const historical = tests.find((t) => t.estimator === "historical")!;
    // A rolling window that starts inside the calm regime under-states risk on
    // the way into the violent one, and the exceptions cluster while it catches
    // up. At least one of the two tests must notice.
    expect(
      Math.min(historical.kupiecP, historical.independenceP),
    ).toBeLessThan(0.05);
  });

  it("keeps every reported probability inside [0, 1]", () => {
    const tests = backtestVar([position()], [returnsWithVol(600, 0.03, 31)], {
      trainWindow: 200,
    });
    for (const t of tests) {
      for (const p of [t.kupiecP, t.independenceP, t.conditionalCoverageP]) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
      expect(t.conditionalCoverageLR).toBeCloseTo(
        t.kupiecLR + t.independenceLR,
        10,
      );
    }
  });
});

describe("realised ruin", () => {
  it("is false for an unlevered book that only drifts down slightly", () => {
    const returns = [new Array(60).fill(-0.001)];
    expect(realisedRuin([position()], returns, 0, 30, 0.5)).toBe(false);
  });

  it("is true when the account really does lose the threshold fraction", () => {
    const returns = [new Array(60).fill(-0.05)];
    expect(realisedRuin([position()], returns, 0, 30, 0.5)).toBe(true);
  });

  it("respects the origin: a later window can differ from an earlier one", () => {
    const returns = [[...new Array(30).fill(0.0), ...new Array(30).fill(-0.06)]];
    expect(realisedRuin([position()], returns, 0, 10, 0.5)).toBe(false);
    expect(realisedRuin([position()], returns, 30, 30, 0.5)).toBe(true);
  });

  it("cannot ruin a book with no equity to lose", () => {
    const flat = position({ equity: 0, initialMargin: 0 });
    expect(realisedRuin([flat], [new Array(60).fill(-0.1)], 0, 30, 0.5)).toBe(
      false,
    );
  });
});

describe("survival calibration", () => {
  const returns = [returnsWithVol(700, 0.03, 41)];

  it("returns null when there is not enough history", () => {
    expect(
      calibrateSurvival([position()], [returnsWithVol(80, 0.02, 5)], {
        trainWindow: 120,
      }),
    ).toBeNull();
  });

  it("scores a Brier value inside [0, 1]", () => {
    const c = calibrateSurvival([position()], returns, {
      trainWindow: 150,
      stride: 20,
      pathsPerOrigin: 120,
    })!;
    expect(c).not.toBeNull();
    expect(c.brierScore).toBeGreaterThanOrEqual(0);
    expect(c.brierScore).toBeLessThanOrEqual(1);
    expect(c.origins).toBeGreaterThan(0);
  });

  it("reports an effective sample size far below the origin count", () => {
    const c = calibrateSurvival([position()], returns, {
      trainWindow: 150,
      stride: 5,
      horizonDays: 30,
      pathsPerOrigin: 100,
    })!;
    // Overlapping 30-day horizons every 5 days: the honest sample is ~1/6th.
    expect(c.effectiveSampleSize).toBeLessThan(c.origins / 2);
    expect(c.effectiveSampleSize).toBeGreaterThanOrEqual(1);
  });

  it("puts every origin into exactly one reliability bin", () => {
    const c = calibrateSurvival([position()], returns, {
      trainWindow: 150,
      stride: 15,
      pathsPerOrigin: 100,
    })!;
    const binned = c.bins.reduce((acc, b) => acc + b.count, 0);
    expect(binned).toBe(c.origins);
  });

  it("is deterministic", () => {
    const opts = { trainWindow: 150, stride: 25, pathsPerOrigin: 100 };
    const a = calibrateSurvival([position()], returns, opts)!;
    const b = calibrateSurvival([position()], returns, opts)!;
    expect(a.brierScore).toBe(b.brierScore);
    expect(a.meanPredicted).toBe(b.meanPredicted);
  });

  it("predicts near-certain ruin for a book that always collapses", () => {
    // Every window is a steep decline, so both forecast and outcome should be
    // ~1 and the Brier score should be near zero.
    const doomed = [new Array(600).fill(-0.04)];
    const levered = position({ leverage: 3, initialMargin: 100 / 3, equity: 100 / 3 });
    const c = calibrateSurvival([levered], doomed, {
      trainWindow: 150,
      stride: 25,
      pathsPerOrigin: 100,
    })!;
    expect(c.meanPredicted).toBeGreaterThan(0.9);
    expect(c.observedRate).toBe(1);
    expect(c.brierScore).toBeLessThan(0.02);
  });
});

describe("runBacktest", () => {
  it("assembles both batteries and names a best estimator", () => {
    const report = runBacktest([position()], [returnsWithVol(700, 0.025, 51)], {
      trainWindow: 200,
      pathsPerOrigin: 150,
      stride: 15,
    });
    expect(report.var95).toHaveLength(3);
    expect(report.var99).toHaveLength(3);
    expect(report.bestEstimator).not.toBeNull();
    expect(report.summary.length).toBeGreaterThan(20);
    expect(report.calibration).not.toBeNull();
  });

  it("degrades honestly rather than throwing on a short sample", () => {
    const report = runBacktest([position()], [returnsWithVol(40, 0.02, 61)], {
      trainWindow: 120,
    });
    expect(report.calibration).toBeNull();
    expect(report.bestEstimator).toBeNull();
    expect(report.summary).toContain("Not enough history");
  });
});
