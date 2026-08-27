import type { PricedPosition, StressResult } from "@/lib/types";
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
   */
  betaAmplifier: number;
}

/**
 * Named historical shocks, expressed as the benchmark move over the event
 * window. Using real events rather than "what if everything drops 20%" gives
 * the numbers a reference point a user can actually reason about.
 */
export const HISTORICAL_SCENARIOS: Scenario[] = [
  {
    id: "covid-2020",
    name: "COVID crash (12 Mar 2020)",
    description:
      "Liquidity evaporated across every asset class in a single session. The reference case for a one-day cascade.",
    benchmarkShock: -0.37,
    betaAmplifier: 1.3,
  },
  {
    id: "may-2021",
    name: "May 2021 deleveraging",
    description:
      "A week of forced unwinds after a record build-up of perp open interest. Alts fell roughly twice as far as BTC.",
    benchmarkShock: -0.3,
    betaAmplifier: 1.4,
  },
  {
    id: "luna-2022",
    name: "Terra/LUNA collapse (May 2022)",
    description:
      "A single protocol failure that propagated through the whole market via lending desks and correlated collateral.",
    benchmarkShock: -0.22,
    betaAmplifier: 1.5,
  },
  {
    id: "ftx-2022",
    name: "FTX insolvency (Nov 2022)",
    description:
      "Venue-level counterparty failure. Correlations converged to one and liquidity on alt pairs disappeared first.",
    benchmarkShock: -0.2,
    betaAmplifier: 1.45,
  },
  {
    id: "yen-carry-2024",
    name: "Yen carry unwind (Aug 2024)",
    description:
      "A macro shock originating entirely outside crypto, showing the book is not insulated from rates positioning.",
    benchmarkShock: -0.16,
    betaAmplifier: 1.2,
  },
  {
    id: "flash-15",
    name: "Hypothetical: -15% benchmark day",
    description:
      "A move of this size has occurred many times. Included as the routine case rather than the tail case.",
    benchmarkShock: -0.15,
    betaAmplifier: 1.15,
  },
  {
    id: "melt-up",
    name: "Hypothetical: +25% benchmark rally",
    description:
      "Upside scenario. Included because short and hedged books carry real risk in a squeeze.",
    benchmarkShock: 0.25,
    betaAmplifier: 1.1,
  },
];

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
      const beta = (betas[p.coinId] ?? 1) * scenario.betaAmplifier;
      const shock = beta * scenario.benchmarkShock;
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
          // Loss is capped at the margin posted: you cannot lose more than the
          // isolated collateral on the position.
          pnl -= p.initialMargin + p.unrealizedPnl;
          perAsset.push({
            symbol: p.symbol,
            shock,
            pnl: -(p.initialMargin + p.unrealizedPnl),
          });
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
      pnl,
      equityAfter,
      equityChangePct: startingEquity > 0 ? pnl / startingEquity : 0,
      liquidated,
      perAsset: perAsset.sort((a, b) => a.pnl - b.pnl),
    };
  });
}
