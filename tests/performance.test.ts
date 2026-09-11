import { describe, expect, it } from "vitest";
import type { PricedPosition } from "@/lib/types";
import {
  computePerformance,
  drawdownSeries,
} from "@/lib/risk/performance";
import { resolveScenarios, runStressTests, HISTORICAL_SCENARIOS } from "@/lib/risk/stress";

const DAY = 86_400_000;

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

function stamps(n: number): number[] {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: n + 1 }, (_, i) => start + i * DAY);
}

/**
 * Regression tests for two bugs that both produced impossible drawdowns.
 * Neither would have been caught by a test that only checked for NaN.
 */
describe("drawdown back-cast", () => {
  it("never reports a drawdown outside [-1, 0]", () => {
    // A brutal path on a levered book. The old constant-notional walk reported
    // -335% here; anything below -100% is definitionally a bug.
    const levered = position({
      leverage: 5,
      initialMargin: 20,
      equity: 20,
      notional: 100,
    });
    const returns = [new Array(200).fill(-0.05)];
    const points = drawdownSeries(stamps(200), [levered], returns);

    expect(points.length).toBe(200);
    for (const p of points) {
      expect(p.drawdown).toBeGreaterThanOrEqual(-1);
      expect(p.drawdown).toBeLessThanOrEqual(0);
      expect(p.equityIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it("CANNOT take an unlevered spot book to zero", () => {
    // The core of the constant-notional bug: holding dollar exposure fixed
    // re-levers into every drawdown and can zero an unlevered account, which
    // is impossible in reality. Holding quantity fixed cannot.
    const returns = [new Array(400).fill(-0.02)];
    const points = drawdownSeries(stamps(400), [position()], returns);

    expect(points.some((p) => p.ruined)).toBe(false);
    expect(points[points.length - 1].equityIndex).toBeGreaterThan(0);
    expect(Math.min(...points.map((p) => p.drawdown))).toBeGreaterThan(-1);
  });

  it("marks the account ruined and keeps it ruined", () => {
    const levered = position({
      leverage: 10,
      initialMargin: 10,
      equity: 10,
      notional: 100,
    });
    // Down hard, then a large recovery the closed account cannot participate in.
    const returns = [[...new Array(30).fill(-0.08), ...new Array(30).fill(0.2)]];
    const points = drawdownSeries(stamps(60), [levered], returns);

    const firstRuin = points.findIndex((p) => p.ruined);
    expect(firstRuin).toBeGreaterThan(-1);
    // Absorbing: once gone, gone. No resurrection on the way back up.
    for (let i = firstRuin; i < points.length; i++) {
      expect(points[i].ruined).toBe(true);
      expect(points[i].equityIndex).toBe(0);
      expect(points[i].drawdown).toBe(-1);
    }
  });

  it("is flat at zero drawdown for a flat market", () => {
    const points = drawdownSeries(stamps(50), [position()], [
      new Array(50).fill(0),
    ]);
    for (const p of points) {
      expect(p.drawdown).toBeCloseTo(0, 10);
      expect(p.equityIndex).toBeCloseTo(1, 10);
    }
  });

  it("returns an empty series rather than throwing on degenerate input", () => {
    expect(drawdownSeries([], [position()], [])).toEqual([]);
    expect(drawdownSeries(stamps(10), [], [])).toEqual([]);
  });
});

describe("Sortino downside deviation", () => {
  it("averages squared downside over ALL observations, not just losing days", () => {
    // Ten days: one -10% day, nine flat. LPM(2) about zero is
    //   sqrt( 0.10^2 / 10 ) = 0.0316...
    // Dividing by the single downside day instead would give 0.10 — a
    // denominator 3.16x too large, and a Sortino ratio 3.16x too small.
    const returns = [-0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const perf = computePerformance(returns, 1, returns, returns, []);

    const expectedDownsideDev = Math.sqrt(0.01 / 10);
    const dailyMean = -0.01;
    const expectedSortino =
      (dailyMean * 365) / (expectedDownsideDev * Math.sqrt(365));

    expect(perf.sortino).toBeCloseTo(expectedSortino, 8);
  });

  it("reports zero drawdown fields when given no drawdown series", () => {
    const perf = computePerformance([0.01, -0.01], 1, [0.01, -0.01], [0.01, -0.01], []);
    expect(perf.maxDrawdown).toBe(0);
    expect(perf.backcastRuined).toBe(false);
    expect(perf.backcastRuinTimestamp).toBeNull();
  });
});

describe("stress scenario provenance", () => {
  const positions = [position()];

  it("leaves scenarios assumed when there is no data covering the window", () => {
    const resolved = resolveScenarios([], ["bitcoin"], "bitcoin");
    expect(resolved.every((s) => s.provenance === "assumed")).toBe(true);
  });

  it("measures a scenario when the dataset covers its window", () => {
    // A synthetic series spanning the FTX window, ending 20% below its start.
    const start = Date.UTC(2022, 9, 1); // 1 Oct 2022
    const n = 90;
    const prices = Array.from({ length: n }, (_, i) => 100 * (1 - (0.2 * i) / n));
    const history = [
      {
        coinId: "bitcoin",
        symbol: "BTC",
        timestamps: Array.from({ length: n }, (_, i) => start + i * DAY),
        prices,
      },
    ];

    const resolved = resolveScenarios(history, ["bitcoin"], "bitcoin");
    const ftx = resolved.find((s) => s.id === "ftx-2022")!;

    expect(ftx.provenance).toBe("measured");
    expect(ftx.measuredReturns?.bitcoin).toBeDefined();
    // 5 Nov to 14 Nov on a straight -20%/90d ramp is a small negative move.
    expect(ftx.measuredReturns!.bitcoin).toBeLessThan(0);
    expect(ftx.sourceNote).toContain("Measured");
  });

  it("refuses to measure when only some held assets are covered", () => {
    const start = Date.UTC(2022, 9, 1);
    const n = 90;
    const history = [
      {
        coinId: "bitcoin",
        symbol: "BTC",
        timestamps: Array.from({ length: n }, (_, i) => start + i * DAY),
        prices: new Array(n).fill(100),
      },
    ];
    // SOL is held but absent from the dataset: a half-measured scenario would
    // silently mix a real BTC move with a modelled SOL one.
    const resolved = resolveScenarios(history, ["bitcoin", "solana"], "bitcoin");
    expect(resolved.find((s) => s.id === "ftx-2022")!.provenance).toBe("assumed");
  });

  it("never measures a purely hypothetical scenario", () => {
    const resolved = resolveScenarios([], ["bitcoin"], "bitcoin");
    const hypothetical = resolved.filter((s) => s.window === null);
    expect(hypothetical.length).toBeGreaterThan(0);
    expect(hypothetical.every((s) => s.provenance === "assumed")).toBe(true);
  });

  it("carries provenance through to the stress results", () => {
    const results = runStressTests(positions, { bitcoin: 1 }, 100, HISTORICAL_SCENARIOS);
    expect(results.length).toBe(HISTORICAL_SCENARIOS.length);
    for (const r of results) {
      expect(["assumed", "measured"]).toContain(r.provenance);
    }
  });

  it("caps a levered loss at the margin posted", () => {
    const levered = position({
      leverage: 5,
      initialMargin: 20,
      equity: 20,
      notional: 100,
    });
    const results = runStressTests([levered], { bitcoin: 1 }, 20, [
      {
        id: "wipeout",
        name: "wipeout",
        description: "",
        benchmarkShock: -0.9,
        betaAmplifier: 1,
        window: null,
        provenance: "assumed",
      },
    ]);
    // You cannot lose more than the isolated collateral on the position.
    expect(results[0].pnl).toBeCloseTo(-20, 8);
    expect(results[0].liquidated).toEqual(["BTC"]);
  });
});
