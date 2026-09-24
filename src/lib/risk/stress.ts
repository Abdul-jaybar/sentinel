import type { PriceSeries, PricedPosition, StressResult } from "@/lib/types";
import { defaultMaintenanceMarginRate } from "./cascade";

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** Single-day (or multi-day cumulative) benchmark shock. */
  benchmarkShock: number;
  /**
   * Multiplier applied to each asset's beta in this scenario. In genuine
   * risk-off events betas compress upward — everything becomes a leveraged
   * BTC trade — so a plain historical beta understates the damage.
   *
   * Only used when the scenario is `assumed`. A `measured` scenario needs no
   * amplifier because it already contains what each asset actually did.
   */
  betaAmplifier: number;
  /**
   * The real calendar window this scenario refers to, as YYYY-MM-DD.
   * Null for hypothetical scenarios, which have no window to measure.
   */
  window: { start: string; end: string } | null;
  /**
   * How the shock numbers were arrived at.
   *
   *  "assumed"  — a hand-specified benchmark move propagated to each asset by
   *               its beta. An approximation, and labelled as one everywhere
   *               it is displayed.
   *  "measured" — the actual per-asset cumulative return realised over the
   *               window, read out of the bundled reference dataset. No beta
   *               model in the path at all.
   *
   * Scenarios are declared `assumed` and upgraded to `measured` at runtime by
   * `resolveScenarios` whenever the dataset covers the window. Nothing in the
   * UI ever has to guess which it is looking at.
   */
  provenance: "assumed" | "measured";
  /** Per-asset realised returns over the window, keyed by coin id. */
  measuredReturns?: Record<string, number>;
  /** Where an assumed number came from, so it can be challenged. */
  sourceNote?: string;
}

/**
 * Named historical shocks.
 *
 * Using real events rather than "what if everything drops 20%" gives the
 * numbers a reference point a user can reason about — but only if the numbers
 * are real. Each scenario below carries the calendar window it refers to, and
 * `resolveScenarios` replaces the assumed shock with the returns that actually
 * happened in that window whenever the reference dataset reaches back far
 * enough. Run `npm run fetch:history` to extend it.
 *
 * Until then the shocks are approximations of the published moves, labelled
 * `assumed` in the type, in the API response, and on screen.
 */
export const HISTORICAL_SCENARIOS: Scenario[] = [
  {
    id: "covid-2020",
    name: "COVID crash (12 Mar 2020)",
    description:
      "Liquidity evaporated across every asset class in a single session. The reference case for a one-day cascade.",
    benchmarkShock: -0.37,
    betaAmplifier: 1.3,
    window: { start: "2020-03-11", end: "2020-03-13" },
    provenance: "assumed",
    sourceNote:
      "BitMEX BTC perp traded 7,353 at 10:00 UTC on 12 Mar and bottomed at 3,596 early on 13 Mar — roughly -51% intraday. -37% is the daily-close move, which is what a daily-bar model can honestly claim.",
  },
  {
    id: "may-2021",
    name: "May 2021 deleveraging",
    description:
      "A week of forced unwinds after a record build-up of perp open interest. Alts fell roughly twice as far as BTC.",
    benchmarkShock: -0.3,
    betaAmplifier: 1.4,
    window: { start: "2021-05-12", end: "2021-05-23" },
    provenance: "assumed",
    sourceNote: "Approximate BTC peak-to-trough over the deleveraging window.",
  },
  {
    id: "luna-2022",
    name: "Terra/LUNA collapse (May 2022)",
    description:
      "A single protocol failure that propagated through the whole market via lending desks and correlated collateral.",
    benchmarkShock: -0.22,
    betaAmplifier: 1.5,
    window: { start: "2022-05-05", end: "2022-05-13" },
    provenance: "assumed",
    sourceNote: "Approximate BTC move across the depeg week.",
  },
  {
    id: "ftx-2022",
    name: "FTX insolvency (Nov 2022)",
    description:
      "Venue-level counterparty failure. Correlations converged to one and liquidity on alt pairs disappeared first.",
    benchmarkShock: -0.2,
    betaAmplifier: 1.45,
    window: { start: "2022-11-05", end: "2022-11-14" },
    provenance: "assumed",
    sourceNote: "Approximate BTC move from pre-collapse to the November low.",
  },
  {
    id: "yen-carry-2024",
    name: "Yen carry unwind (Aug 2024)",
    description:
      "A macro shock originating entirely outside crypto, showing the book is not insulated from rates positioning.",
    benchmarkShock: -0.16,
    betaAmplifier: 1.2,
    window: { start: "2024-08-01", end: "2024-08-06" },
    provenance: "assumed",
    sourceNote: "Approximate BTC move over the carry unwind.",
  },
  {
    id: "flash-15",
    name: "Hypothetical: -15% benchmark day",
    description:
      "A move of this size has occurred many times. Included as the routine case rather than the tail case.",
    benchmarkShock: -0.15,
    betaAmplifier: 1.15,
    window: null,
    provenance: "assumed",
  },
  {
    id: "melt-up",
    name: "Hypothetical: +25% benchmark rally",
    description:
      "Upside scenario. Included because short and hedged books carry real risk in a squeeze.",
    benchmarkShock: 0.25,
    betaAmplifier: 1.1,
    window: null,
    provenance: "assumed",
  },
];

const DAY_MS = 86_400_000;

function toDayKey(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

/**
 * Upgrade every scenario whose window the dataset actually covers from an
 * assumed beta-propagated shock to the measured per-asset return.
 *
 * The measured path is strictly better in two ways. It removes the beta model
 * from the calculation entirely — no amplifier, no single-factor assumption —
 * and it captures the thing the beta model gets most wrong, which is that in a
 * real cascade the dispersion across alts is enormous and not a clean multiple
 * of the benchmark.
 *
 * A window is only used if EVERY held asset has data covering it. Mixing a
 * measured return for BTC with an assumed one for an alt that did not exist in
 * 2020 would be the worst of both, so a partially covered window stays assumed.
 */
export function resolveScenarios(
  history: PriceSeries[],
  coinIds: string[],
  benchmarkCoinId: string,
  scenarios: Scenario[] = HISTORICAL_SCENARIOS,
): Scenario[] {
  const needed = [...new Set([...coinIds, benchmarkCoinId])];

  const index = new Map<string, Map<number, number>>();
  for (const s of history) {
    const m = new Map<number, number>();
    for (let i = 0; i < s.timestamps.length; i++) {
      const p = s.prices[i];
      if (Number.isFinite(p) && p > 0) m.set(Math.floor(s.timestamps[i] / DAY_MS), p);
    }
    index.set(s.coinId, m);
  }

  /** Price on `day`, or the most recent close within 3 days before it. */
  const priceAt = (coinId: string, day: number): number | null => {
    const m = index.get(coinId);
    if (!m) return null;
    for (let back = 0; back <= 3; back++) {
      const p = m.get(day - back);
      if (p !== undefined) return p;
    }
    return null;
  };

  return scenarios.map((scenario) => {
    if (!scenario.window) return scenario;

    const start = toDayKey(scenario.window.start);
    const end = toDayKey(scenario.window.end);
    const measuredReturns: Record<string, number> = {};

    for (const coinId of needed) {
      const p0 = priceAt(coinId, start);
      const p1 = priceAt(coinId, end);
      if (p0 === null || p1 === null || p0 <= 0) return scenario;
      measuredReturns[coinId] = p1 / p0 - 1;
    }

    return {
      ...scenario,
      provenance: "measured" as const,
      measuredReturns,
      benchmarkShock: measuredReturns[benchmarkCoinId] ?? scenario.benchmarkShock,
      sourceNote: `Measured from the bundled daily dataset, ${scenario.window.start} to ${scenario.window.end}.`,
    };
  });
}

export function runStressTests(
  positions: PricedPosition[],
  betas: Record<string, number>,
  startingEquity: number,
  scenarios: Scenario[] = HISTORICAL_SCENARIOS,
): StressResult[] {
  return scenarios.map((scenario) => {
    const perAsset: StressResult["perAsset"] = [];
    const liquidated: string[] = [];
    let pnl = 0;

    for (const p of positions) {
      // A measured scenario knows what this asset actually did. An assumed one
      // has to propagate the benchmark move through a beta, which is the
      // approximation the provenance flag exists to disclose.
      const shock =
        scenario.provenance === "measured" &&
        scenario.measuredReturns?.[p.coinId] !== undefined
          ? scenario.measuredReturns[p.coinId]
          : (betas[p.coinId] ?? 1) *
            scenario.betaAmplifier *
            scenario.benchmarkShock;

      const shockedPrice = Math.max(0, p.price * (1 + shock));
      const positionPnl = p.quantity * (shockedPrice - p.price);

      const positionEquity =
        p.initialMargin + p.quantity * (shockedPrice - p.entryPrice);

      if (p.leverage > 1) {
        const mmr =
          p.maintenanceMarginRate ?? defaultMaintenanceMarginRate(p.leverage);
        const maintenance = Math.abs(p.quantity * shockedPrice) * mmr;
        if (positionEquity <= maintenance) {
          liquidated.push(p.symbol);
          // Liquidation wipes out whatever equity the position has left, and
          // no more: you cannot lose more than the isolated collateral. If the
          // position is already underwater, it has nothing left to lose, and
          // closing it must not show up as a gain.
          const loss = Math.max(0, p.initialMargin + p.unrealizedPnl);
          pnl -= loss;
          perAsset.push({ symbol: p.symbol, shock, pnl: -loss });
          continue;
        }
      }

      pnl += positionPnl;
      perAsset.push({ symbol: p.symbol, shock, pnl: positionPnl });
    }

    const equityAfter = startingEquity + pnl;
    return {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description,
      benchmarkShock: scenario.benchmarkShock,
      provenance: scenario.provenance,
      sourceNote: scenario.sourceNote ?? null,
      pnl,
      equityAfter,
      equityChangePct: startingEquity > 0 ? pnl / startingEquity : 0,
      liquidated,
      perAsset: perAsset.sort((a, b) => a.pnl - b.pnl),
    };
  });
}
