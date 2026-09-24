"use client";

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { BacktestReport, VarExceptionTest } from "@/lib/risk/backtest";
import type { Position } from "@/lib/types";
import { Badge, Button, Card, Caveat, ChartFrame, Stat } from "./ui";

const ESTIMATOR_LABEL: Record<string, string> = {
  historical: "Historical simulation",
  parametric: "Variance-covariance",
  "cornish-fisher": "Cornish-Fisher",
};

const VERDICT_TONE = {
  pass: "safe",
  marginal: "warn",
  fail: "crit",
} as const;

/**
 * Out-of-sample validation.
 *
 * Every other panel in this app is the model talking. This one is the model
 * being marked. It is deliberately the only panel that has to be asked for:
 * it costs a second of compute, and more importantly it is meant to be read
 * rather than glanced at.
 */
export function ValidationPanel({ positions }: { positions: Position[] }) {
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [computeMs, setComputeMs] = useState<number | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setDetail(null);
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions, lookbackDays: 730, trainWindow: 120 }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Validation failed.");
        setDetail(json.detail ?? null);
        setReport(null);
      } else {
        setReport(json.backtest);
        setComputeMs(json.computeMs ?? null);
      }
    } catch {
      setError("Could not reach the validation endpoint.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card
      title="Does the model actually work?"
      subtitle="Out-of-sample validation. Every forecast below was produced from data ending the day before the outcome it is scored against."
      aside={
        <Button onClick={run} disabled={loading || positions.length === 0} variant="primary">
          {loading ? "Validating…" : report ? "Re-run" : "Run validation"}
        </Button>
      }
    >
      {!report && !error && !loading && (
        <div className="space-y-3 text-[13px] leading-relaxed text-ink-300">
          <p>
            A risk model that has never been backtested is a risk model that has
            never been contradicted. This runs two independent checks:
          </p>
          <ul className="ml-4 list-disc space-y-1.5 text-ink-400">
            <li>
              <span className="text-ink-200">VaR exception testing</span> — walks
              the history one day at a time, re-estimating all three VaR models
              from a rolling window, and applies the Kupiec and Christoffersen
              tests to the exceptions. It answers which estimator is calibrated
              on <em>this</em> book, rather than showing three numbers and
              leaving you to pick.
            </li>
            <li>
              <span className="text-ink-200">Survival calibration</span> — asks
              whether the headline ruin probability means anything, by comparing
              what the simulation predicted at each historical origin against
              what actually happened over the following window.
            </li>
          </ul>
        </div>
      )}

      {loading && (
        <p className="text-[13px] text-ink-400">
          Re-simulating at every walk-forward origin. This is the slow one.
        </p>
      )}

      {error && (
        <div className="space-y-2">
          <p className="text-[13px] text-signal-warn">{error}</p>
          {detail && <p className="text-[12px] leading-relaxed text-ink-400">{detail}</p>}
        </div>
      )}

      {report && (
        <div className="space-y-7">
          <div>
            <p className="text-[13.5px] leading-relaxed text-ink-200">{report.summary}</p>
            <p className="mt-1.5 text-[11.5px] text-ink-500">
              {report.lookbackDays} aligned days · {report.trainWindow}-day rolling
              training window
              {computeMs !== null ? ` · ${computeMs} ms` : ""}
            </p>
          </div>

          <VarTable title="95% one-day VaR" tests={report.var95} />
          <VarTable title="99% one-day VaR" tests={report.var99} />

          {report.calibration && <CalibrationBlock calibration={report.calibration} />}
        </div>
      )}
    </Card>
  );
}

function VarTable({ title, tests }: { title: string; tests: VarExceptionTest[] }) {
  const scored = tests.filter((t) => t.observations > 0);
  if (scored.length === 0) return null;

  return (
    <div>
      <h3 className="text-[11px] font-semibold tracking-[0.16em] text-ink-300 uppercase">
        {title}
      </h3>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-ink-700/60 text-left text-[10.5px] tracking-[0.12em] text-ink-500 uppercase">
              <th className="py-2 pr-3 font-medium">Estimator</th>
              <th className="py-2 pr-3 text-right font-medium">Exceptions</th>
              <th className="py-2 pr-3 text-right font-medium">Rate</th>
              <th className="py-2 pr-3 text-right font-medium">Kupiec p</th>
              <th className="py-2 pr-3 text-right font-medium">Indep. p</th>
              <th className="py-2 pr-3 text-right font-medium">Joint p</th>
              <th className="py-2 text-right font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {scored.map((t) => (
              <tr key={t.estimator} className="border-b border-ink-800/60 align-top">
                <td className="py-2.5 pr-3 text-ink-200">
                  {ESTIMATOR_LABEL[t.estimator] ?? t.estimator}
                  <div className="mt-1 max-w-[34ch] text-[11.5px] leading-relaxed text-ink-500">
                    {t.diagnosis}
                  </div>
                </td>
                <td className="tnum py-2.5 pr-3 text-right text-ink-200">
                  {t.exceptions}
                  <span className="text-ink-500"> / {t.observations}</span>
                  <div className="text-[11px] text-ink-500">
                    {t.expectedExceptions.toFixed(1)} expected
                  </div>
                </td>
                <td className="tnum py-2.5 pr-3 text-right text-ink-200">
                  {(t.exceptionRate * 100).toFixed(2)}%
                  <div className="text-[11px] text-ink-500">
                    vs {((1 - t.confidence) * 100).toFixed(0)}%
                  </div>
                </td>
                <td className="tnum py-2.5 pr-3 text-right text-ink-300">
                  {t.kupiecP.toFixed(3)}
                </td>
                <td className="tnum py-2.5 pr-3 text-right text-ink-300">
                  {t.independenceP.toFixed(3)}
                </td>
                <td className="tnum py-2.5 pr-3 text-right text-ink-300">
                  {t.conditionalCoverageP.toFixed(3)}
                </td>
                <td className="py-2.5 text-right">
                  <Badge tone={VERDICT_TONE[t.verdict]}>{t.verdict}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Caveat>
        Kupiec tests whether the <em>number</em> of exceptions is right.
        Christoffersen tests whether they are <em>independent</em> — ten
        exceptions spread evenly and ten on consecutive days score identically
        on the first test and very differently on the second, and it is the
        clustered case that closes accounts. The joint column is both together.
        A low p-value rejects the model, not the portfolio.
      </Caveat>
    </div>
  );
}

function CalibrationBlock({
  calibration,
}: {
  calibration: NonNullable<BacktestReport["calibration"]>;
}) {
  const c = calibration;
  const points = c.bins
    .filter((b) => b.count > 0)
    .map((b) => ({
      predicted: b.meanPredicted,
      observed: b.observedFrequency,
      count: b.count,
    }));

  const skillTone = c.brierSkillScore > 0 ? "safe" : "warn";

  return (
    <div>
      <h3 className="text-[11px] font-semibold tracking-[0.16em] text-ink-300 uppercase">
        Survival calibration
      </h3>

      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Brier score"
          value={c.brierScore.toFixed(3)}
          sub="lower is better"
          size="sm"
        />
        <Stat
          label="Skill vs base rate"
          value={c.brierSkillScore.toFixed(3)}
          sub={c.brierSkillScore > 0 ? "beats a constant forecast" : "no better than a constant"}
          tone={skillTone}
          size="sm"
        />
        <Stat
          label="Mean forecast"
          value={`${(c.meanPredicted * 100).toFixed(1)}%`}
          sub={`observed ${(c.observedRate * 100).toFixed(1)}%`}
          size="sm"
        />
        <Stat
          label="Independent windows"
          value={String(c.effectiveSampleSize)}
          sub={`from ${c.origins} origins`}
          size="sm"
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[11.5px] text-ink-400">
            Reliability: each point is a bucket of forecasts. Perfect calibration
            sits on the diagonal.
          </p>
          <ChartFrame height={240}>
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 8, right: 12, bottom: 24, left: 4 }}>
                <CartesianGrid stroke="#1c2333" strokeDasharray="2 4" />
                <XAxis
                  type="number"
                  dataKey="predicted"
                  domain={[0, 1]}
                  tick={{ fontSize: 11, fill: "#64708a" }}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                  label={{
                    value: "forecast",
                    position: "insideBottom",
                    offset: -14,
                    style: { fontSize: 11, fill: "#64708a" },
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="observed"
                  domain={[0, 1]}
                  tick={{ fontSize: 11, fill: "#64708a" }}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                />
                <ZAxis type="number" dataKey="count" range={[60, 400]} />
                <ReferenceLine
                  segment={[
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                  ]}
                  stroke="#3d485f"
                  strokeDasharray="4 4"
                />
                <Tooltip
                  contentStyle={{
                    background: "#0e131d",
                    border: "1px solid #2a3346",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value, name) => [
                    `${(Number(value) * 100).toFixed(1)}%`,
                    name,
                  ]}
                />
                <Scatter data={points} fill="#60a5fa" />
              </ScatterChart>
            </ResponsiveContainer>
          </ChartFrame>
        </div>

        <div>
          <p className="mb-2 text-[11.5px] text-ink-400">
            Forecast against outcome, by bucket.
          </p>
          <ChartFrame height={240}>
            <ResponsiveContainer>
              <LineChart
                data={points}
                margin={{ top: 8, right: 12, bottom: 24, left: 4 }}
              >
                <CartesianGrid stroke="#1c2333" strokeDasharray="2 4" />
                <XAxis
                  dataKey="predicted"
                  tick={{ fontSize: 11, fill: "#64708a" }}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                />
                <YAxis
                  domain={[0, 1]}
                  tick={{ fontSize: 11, fill: "#64708a" }}
                  tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                />
                <Tooltip
                  contentStyle={{
                    background: "#0e131d",
                    border: "1px solid #2a3346",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value) => `${(Number(value) * 100).toFixed(1)}%`}
                />
                <Line
                  type="monotone"
                  dataKey="predicted"
                  stroke="#3d485f"
                  strokeDasharray="4 4"
                  dot={false}
                  name="forecast"
                />
                <Line
                  type="monotone"
                  dataKey="observed"
                  stroke="#fb7185"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  name="observed"
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {c.notes.map((note) => (
          <p key={note} className="text-[11.5px] leading-relaxed text-ink-400">
            {note}
          </p>
        ))}
      </div>

      <Caveat>
        A model that is well calibrated on a sample this size is not proven
        correct — there is not enough independent evidence for that. A model
        that is badly calibrated on one <em>is</em> proven wrong. That asymmetry
        is the entire reason this panel exists, and it is why the number to look
        at is the direction of the bias rather than the third decimal place.
      </Caveat>
    </div>
  );
}
