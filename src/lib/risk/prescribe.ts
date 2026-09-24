import type { PricedPosition } from "@/lib/types";
import { simulateSurvival } from "./survival";

export type ActionKind = "trim" | "close" | "deleverage" | "add-margin" | "hedge";

export interface PrescribedAction {
  id: string;
  kind: ActionKind;
  symbol: string;
  label: string;
  detail: string;
  /** Ruin probability if this action is taken. */
  ruinProbabilityAfter: number;
  /** baseline - after. Positive is an improvement. */
  ruinReduction: number;
  /** Exposure closed, USD. Zero for margin-only actions. */
  exposureClosed: number;
  /** Additional capital required, USD. Zero for size reductions. */
  capitalRequired: number;
  /**
   * Percentage points of ruin probability removed per 1% of gross exposure
   * given up (or per 1% of equity added). The ranking metric: it finds the
   * cheapest fix, not merely the biggest one.
   */
  efficiency: number;
}

export interface PrescriptionReport {
  baselineRuinProbability: number;
  actions: PrescribedAction[];
  /** Paths used for candidate evaluation (lower than the headline run). */
  evaluationPaths: number;
}

function clonePosition(p: PricedPosition): PricedPosition {
  return { ...p };
}

/** Rebuild the derived exposure fields after changing quantity or leverage. */
function reprice(p: PricedPosition): PricedPosition {
  const notional = p.quantity * p.price;
  const initialMargin = Math.abs(p.quantity * p.entryPrice) / p.leverage;
  const unrealizedPnl = p.quantity * (p.price - p.entryPrice);
  return {
    ...p,
    notional,
    initialMargin,
    unrealizedPnl,
    equity: initialMargin + unrealizedPnl,
  };
}

/**
 * Search the space of realistic de-risking actions and rank them by how much
 * ruin probability they remove per unit of cost.
 *
 * This is the part that makes the tool worth opening twice. Every risk
 * dashboard can tell you that you are over-exposed. Almost none will tell you
 * *which single trade fixes it most cheaply*, because that requires
 * re-simulating the whole portfolio under each candidate rather than reading a
 * number off a table. Each candidate is evaluated with the same seed and the
 * same bootstrap draws as the baseline, so differences reflect the action and
 * not simulation noise.
 */
export function prescribeActions(
  positions: PricedPosition[],
  returnMatrix: number[][],
  coinIndex: Record<string, number>,
  options: {
    horizonDays?: number;
    ruinThreshold?: number;
    evaluationPaths?: number;
    maxActions?: number;
  } = {},
): PrescriptionReport {
  const horizonDays = options.horizonDays ?? 30;
  const ruinThreshold = options.ruinThreshold ?? 0.5;
  const evaluationPaths = options.evaluationPaths ?? 400;
  const maxActions = options.maxActions ?? 5;

  const simOpts = {
    horizonDays,
    ruinThreshold,
    paths: evaluationPaths,
  };

  const baseline = simulateSurvival(positions, returnMatrix, simOpts);
  const baselineRuin = baseline.ruinProbability;

  const grossExposure =
    positions.reduce((acc, p) => acc + Math.abs(p.notional), 0) || 1;
  const equity = positions.reduce((acc, p) => acc + p.equity, 0) || 1;

  const candidates: PrescribedAction[] = [];

  const evaluate = (
    next: PricedPosition[],
    partial: Omit<
      PrescribedAction,
      "ruinProbabilityAfter" | "ruinReduction" | "efficiency"
    >,
  ) => {
    const matrix = next.map((p) => returnMatrix[coinIndex[p.coinId]] ?? []);
    const result = simulateSurvival(next, matrix, simOpts);
    const reduction = baselineRuin - result.ruinProbability;
    const costPct =
      partial.exposureClosed / grossExposure +
      partial.capitalRequired / equity;
    candidates.push({
      ...partial,
      ruinProbabilityAfter: result.ruinProbability,
      ruinReduction: reduction,
      efficiency: costPct > 1e-9 ? reduction / costPct : 0,
    });
  };

  positions.forEach((p, idx) => {
    // --- Trim / close --------------------------------------------------
    // With a large book the candidate space grows fast and every entry costs
    // a full simulation, so coarser trims are used once there are many
    // positions. The ranking is by efficiency, and efficiency is close to flat
    // in trim size, so the shortlist barely changes.
    const trimFractions = positions.length > 8 ? [0.5, 1] : [0.25, 0.5, 1];
    for (const fraction of trimFractions) {
      const next = positions
        .map(clonePosition)
        .map((q, i) =>
          i === idx ? reprice({ ...q, quantity: q.quantity * (1 - fraction) }) : q,
        )
        .filter((q) => Math.abs(q.quantity) > 1e-12);

      if (next.length === 0) continue;

      const exposureClosed = Math.abs(p.notional) * fraction;
      evaluate(next, {
        id: `${p.id}-trim-${fraction}`,
        kind: fraction === 1 ? "close" : "trim",
        symbol: p.symbol,
        label:
          fraction === 1
            ? `Close ${p.symbol}`
            : `Trim ${p.symbol} by ${Math.round(fraction * 100)}%`,
        detail:
          fraction === 1
            ? `Fully exit the ${p.symbol} position, releasing $${Math.round(
                exposureClosed,
              ).toLocaleString()} of exposure.`
            : `Reduce ${p.symbol} exposure by $${Math.round(
                exposureClosed,
              ).toLocaleString()}, keeping the rest of the position on.`,
        exposureClosed,
        capitalRequired: 0,
      });
    }

    // --- Deleverage by posting more margin -----------------------------
    if (p.leverage > 1) {
      const targets =
        positions.length > 8 ? [1] : [Math.max(1, p.leverage / 2), 1];
      for (const target of targets) {
        if (target >= p.leverage - 1e-9) continue;
        const next = positions
          .map(clonePosition)
          .map((q, i) => (i === idx ? reprice({ ...q, leverage: target }) : q));

        const capitalRequired =
          Math.abs(p.quantity * p.entryPrice) * (1 / target - 1 / p.leverage);

        evaluate(next, {
          id: `${p.id}-delev-${target}`,
          kind: target === 1 ? "add-margin" : "deleverage",
          symbol: p.symbol,
          label:
            target === 1
              ? `Take ${p.symbol} to spot (1x)`
              : `Cut ${p.symbol} leverage to ${target.toFixed(1)}x`,
          detail: `Post $${Math.round(
            capitalRequired,
          ).toLocaleString()} of additional margin. Exposure is unchanged; the liquidation level moves away from spot.`,
          exposureClosed: 0,
          capitalRequired,
        });
      }
    }
  });

  // --- Shortlist selection --------------------------------------------
  //
  // Ranking purely by efficiency produces a list that is technically correct
  // and practically useless: one kind of action usually dominates, so the user
  // is shown "take X to spot" five times with different tickers. A shortlist is
  // only worth reading if the entries are actually different choices, so the
  // selection enforces variety: at most one action per position, and the best
  // representative of each distinct action kind is guaranteed a slot before
  // remaining slots are filled by efficiency.
  const meaningful = candidates
    .filter((c) => c.ruinReduction > 0.005)
    .sort((a, b) => b.efficiency - a.efficiency);

  const bestPerSymbolKind = new Map<string, PrescribedAction>();
  for (const c of meaningful) {
    const key = `${c.symbol}:${c.kind}`;
    if (!bestPerSymbolKind.has(key)) bestPerSymbolKind.set(key, c);
  }
  const pool = [...bestPerSymbolKind.values()].sort(
    (a, b) => b.efficiency - a.efficiency,
  );

  const actions: PrescribedAction[] = [];
  const usedSymbols = new Set<string>();
  const usedKinds = new Set<string>();

  // Pass 1: the best representative of each distinct kind.
  for (const c of pool) {
    if (actions.length >= maxActions) break;
    if (usedKinds.has(c.kind) || usedSymbols.has(c.symbol)) continue;
    actions.push(c);
    usedKinds.add(c.kind);
    usedSymbols.add(c.symbol);
  }

  // Pass 2: fill remaining slots by efficiency, still one action per position,
  // and no more than two entries of any single kind. Beyond that the list
  // stops offering the user a choice and starts repeating itself.
  const kindCounts = new Map<string, number>();
  for (const a of actions) kindCounts.set(a.kind, 1);

  for (const pass of [2, Number.POSITIVE_INFINITY]) {
    for (const c of pool) {
      if (actions.length >= maxActions) break;
      if (usedSymbols.has(c.symbol)) continue;
      if ((kindCounts.get(c.kind) ?? 0) >= pass) continue;
      actions.push(c);
      usedSymbols.add(c.symbol);
      kindCounts.set(c.kind, (kindCounts.get(c.kind) ?? 0) + 1);
    }
  }

  actions.sort((a, b) => b.efficiency - a.efficiency);

  return { baselineRuinProbability: baselineRuin, actions, evaluationPaths };
}
