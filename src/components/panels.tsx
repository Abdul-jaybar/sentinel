"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Info,
  MessageSquare,
  OctagonAlert,
  Send,
} from "lucide-react";
import type { SentinelReport } from "@/lib/risk/engine";
import type { Narrative } from "@/lib/risk/narrate";
import { narrationContext } from "@/lib/risk/narrate";
import { num, pct, price as fmtPrice, signedPct, usd } from "@/lib/format";
import { Badge, Button, Caveat } from "./ui";

/* ------------------------------------------------------------------ */

export function AlertFeed({ report }: { report: SentinelReport }) {
  if (report.alerts.length === 0) {
    return (
      <p className="text-[13px] text-ink-400">
        No rules tripped. That is a statement about thresholds, not a guarantee
        — the metrics below are still worth reading.
      </p>
    );
  }

  const icon = {
    critical: <OctagonAlert className="h-4 w-4 shrink-0 text-signal-crit" />,
    warning: <AlertTriangle className="h-4 w-4 shrink-0 text-signal-warn" />,
    info: <Info className="h-4 w-4 shrink-0 text-signal-info" />,
  };

  const border = {
    critical: "border-l-signal-crit",
    warning: "border-l-signal-warn",
    info: "border-l-signal-info",
  };

  return (
    <ul className="space-y-2.5">
      {report.alerts.map((a) => (
        <li
          key={a.id}
          className={`rise rounded-r-lg border-l-2 bg-ink-850/50 px-4 py-3 ${border[a.severity]}`}
        >
          <div className="flex items-start gap-2.5">
            {icon[a.severity]}
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink-100">
                {a.title}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">
                {a.detail}
              </p>
              <div className="mt-1.5 text-[10.5px] tracking-wide text-ink-500 uppercase">
                {a.rule}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */

export function PrescriptionPanel({ report }: { report: SentinelReport }) {
  const { prescription } = report;

  if (prescription.actions.length === 0) {
    return (
      <div>
        <p className="text-[13px] leading-relaxed text-ink-300">
          No single action moves ruin probability by more than half a
          percentage point. That usually means risk is spread evenly across the
          book rather than concentrated in one position — the lever is overall
          size, not reshuffling between assets.
        </p>
        <Caveat>
          Searched trims of 25/50/100% and leverage reductions on every
          position, each re-simulated over{" "}
          {prescription.evaluationPaths.toLocaleString()} paths.
        </Caveat>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {prescription.actions.map((a, i) => (
        <div
          key={a.id}
          className="rise rounded-lg border border-ink-700/70 bg-ink-850/40 p-4"
          style={{ animationDelay: `${i * 45}ms` }}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {i === 0 && <Badge tone="safe">best value</Badge>}
                <span className="text-[14px] font-semibold text-ink-100">
                  {a.label}
                </span>
              </div>
              <p className="mt-1.5 max-w-xl text-[12.5px] leading-relaxed text-ink-400">
                {a.detail}
              </p>
            </div>
            <div className="flex items-center gap-3 text-right">
              <div>
                <div className="text-[10px] tracking-[0.14em] text-ink-500 uppercase">
                  ruin prob.
                </div>
                <div className="tnum mt-0.5 flex items-center gap-1.5 text-[15px] font-semibold">
                  <span className="text-signal-crit">
                    {pct(prescription.baselineRuinProbability)}
                  </span>
                  <ArrowRight className="h-3 w-3 text-ink-500" />
                  <span className="text-signal-safe">
                    {pct(a.ruinProbabilityAfter)}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-ink-700/50 pt-2.5 text-[11.5px] text-ink-400">
            <span>
              Removes{" "}
              <span className="tnum text-signal-safe">
                {pct(a.ruinReduction)}
              </span>{" "}
              of ruin probability
            </span>
            {a.exposureClosed > 0 && (
              <span>
                Exposure given up{" "}
                <span className="tnum text-ink-200">
                  {usd(a.exposureClosed, { compact: true })}
                </span>
              </span>
            )}
            {a.capitalRequired > 0 && (
              <span>
                Margin required{" "}
                <span className="tnum text-ink-200">
                  {usd(a.capitalRequired, { compact: true })}
                </span>
              </span>
            )}
            <span>
              Efficiency{" "}
              <span className="tnum text-ink-200">{num(a.efficiency, 2)}</span>
            </span>
          </div>
        </div>
      ))}
      <Caveat>
        Ranked by ruin-probability removed per unit of cost, not by raw size of
        the reduction — closing everything always helps most and is never the
        useful answer. Each candidate is re-simulated over{" "}
        {prescription.evaluationPaths.toLocaleString()} paths against the same
        bootstrap draws as the baseline. This is model output about the
        portfolio you entered, not investment advice.
      </Caveat>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function StressTable({ report }: { report: SentinelReport }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-[13px]">
        <thead>
          <tr className="border-b border-ink-700/70 text-[10.5px] tracking-[0.12em] text-ink-400 uppercase">
            <th className="py-2 pr-3 text-left font-medium">Scenario</th>
            <th className="px-3 py-2 text-right font-medium">
              {report.benchmarkSymbol}
            </th>
            <th className="px-3 py-2 text-right font-medium">P&L</th>
            <th className="px-3 py-2 text-right font-medium">Equity change</th>
            <th className="px-3 py-2 text-right font-medium">Equity after</th>
            <th className="py-2 pl-3 text-left font-medium">Liquidated</th>
          </tr>
        </thead>
        <tbody>
          {report.stress.map((s) => (
            <tr
              key={s.id}
              className="border-b border-ink-700/40 last:border-0 align-top hover:bg-ink-850/40"
            >
              <td className="py-3 pr-3">
                <div className="font-medium text-ink-100">{s.name}</div>
                <p className="mt-1 max-w-sm text-[11.5px] leading-relaxed text-ink-500">
                  {s.description}
                </p>
              </td>
              <td className="tnum px-3 py-3 text-right text-ink-300">
                {signedPct(s.benchmarkShock, 0)}
              </td>
              <td
                className="tnum px-3 py-3 text-right"
                style={{
                  color:
                    s.pnl >= 0
                      ? "var(--color-signal-safe)"
                      : "var(--color-signal-crit)",
                }}
              >
                {usd(s.pnl, { compact: true })}
              </td>
              <td
                className="tnum px-3 py-3 text-right font-semibold"
                style={{
                  color:
                    s.equityChangePct >= 0
                      ? "var(--color-signal-safe)"
                      : s.equityChangePct <= -0.5
                        ? "var(--color-signal-crit)"
                        : "var(--color-signal-warn)",
                }}
              >
                {signedPct(s.equityChangePct)}
              </td>
              <td className="tnum px-3 py-3 text-right text-ink-200">
                {usd(Math.max(0, s.equityAfter), { compact: true })}
              </td>
              <td className="py-3 pl-3">
                {s.liquidated.length === 0 ? (
                  <span className="text-ink-500">—</span>
                ) : (
                  <span className="text-signal-crit">
                    {s.liquidated.join(", ")}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Caveat>
        Each asset is shocked by its own beta to {report.benchmarkSymbol},
        amplified for the scenario, because betas compress upward in genuine
        risk-off events. Losses on isolated-margin positions are capped at the
        margin posted. Venue failure, depegs, and liquidity gaps are outside
        this model.
      </Caveat>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function LiquidationTable({ report }: { report: SentinelReport }) {
  if (report.liquidation.length === 0) {
    return (
      <p className="text-[13px] text-ink-400">
        Nothing here is levered, so nothing can be force-closed. Drawdown risk
        still applies.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-[13px]">
        <thead>
          <tr className="border-b border-ink-700/70 text-[10.5px] tracking-[0.12em] text-ink-400 uppercase">
            <th className="py-2 pr-3 text-left font-medium">Position</th>
            <th className="px-3 py-2 text-right font-medium">Mark</th>
            <th className="px-3 py-2 text-right font-medium">Liq. price</th>
            <th className="px-3 py-2 text-right font-medium">Distance</th>
            <th className="py-2 pl-3 text-right font-medium">
              P(touch {report.liquidation[0]?.horizonDays ?? 30}d)
            </th>
          </tr>
        </thead>
        <tbody>
          {report.liquidation.map((l) => (
            <tr
              key={l.coinId}
              className="border-b border-ink-700/40 last:border-0 hover:bg-ink-850/40"
            >
              <td className="py-2.5 pr-3">
                <span className="font-semibold text-ink-100">{l.symbol}</span>
                <span className="ml-2 text-ink-400">
                  {l.leverage}x {l.side}
                </span>
              </td>
              <td className="tnum px-3 py-2.5 text-right text-ink-300">
                {fmtPrice(l.price)}
              </td>
              <td className="tnum px-3 py-2.5 text-right text-signal-crit">
                {fmtPrice(l.liquidationPrice)}
              </td>
              <td className="tnum px-3 py-2.5 text-right text-ink-200">
                {pct(l.distancePct)}
              </td>
              <td
                className="tnum py-2.5 pl-3 text-right font-semibold"
                style={{
                  color:
                    l.probTouch30d >= 0.5
                      ? "var(--color-signal-crit)"
                      : l.probTouch30d >= 0.25
                        ? "var(--color-signal-warn)"
                        : "var(--color-signal-safe)",
                }}
              >
                {pct(l.probTouch30d)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Caveat>
        Touch probability uses the reflection principle for driftless geometric
        Brownian motion — the chance of trading through the level at any point
        in the window, not of closing below it. Funding costs and venue-specific
        margin tiers are not modelled.
      </Caveat>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function NarrativePanel({
  report,
  narrative,
}: {
  report: SentinelReport;
  narrative: Narrative;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "unavailable">(
    "idle",
  );

  async function ask() {
    if (!question.trim()) return;
    setStatus("loading");
    setAnswer(null);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question,
          context: narrationContext(report),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAnswer(data.message ?? data.error ?? "The co-pilot is unavailable.");
        setStatus("unavailable");
        return;
      }
      setAnswer(data.answer);
      setStatus("idle");
    } catch {
      setAnswer("Could not reach the co-pilot.");
      setStatus("unavailable");
    }
  }

  return (
    <div>
      <p className="text-[15px] leading-relaxed font-medium text-ink-100">
        {narrative.headline}
      </p>
      <div className="mt-4 space-y-3">
        {narrative.paragraphs.map((p, i) => (
          <p key={i} className="text-[13px] leading-relaxed text-ink-300">
            {p}
          </p>
        ))}
      </div>

      <div className="mt-5 border-t border-ink-700/60 pt-4">
        <div className="mb-2 flex items-center gap-2 text-[11px] tracking-[0.14em] text-ink-400 uppercase">
          <MessageSquare className="h-3.5 w-3.5" />
          Ask a follow-up
        </div>
        <div className="flex gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="Why is my tail risk concentrated in SOL?"
            className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-[13px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-signal-accent/60"
          />
          <Button onClick={ask} disabled={status === "loading"} variant="primary">
            <Send className="h-3.5 w-3.5" />
            {status === "loading" ? "Thinking" : "Ask"}
          </Button>
        </div>
        {answer && (
          <div
            className={`mt-3 rounded-lg border px-4 py-3 text-[13px] leading-relaxed ${
              status === "unavailable"
                ? "border-ink-600 bg-ink-850/50 text-ink-400"
                : "border-signal-accent/30 bg-signal-accent/5 text-ink-200"
            }`}
          >
            {answer}
          </div>
        )}
        <Caveat>
          The assessment above is generated deterministically from the report —
          identical portfolios always produce identical wording, and every
          figure traces to a field in the model output. The follow-up box is the
          only part that calls a language model, and it is optional.
        </Caveat>
      </div>
    </div>
  );
}
