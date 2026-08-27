"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SentinelReport } from "@/lib/risk/engine";
import { correlationColor, num, pct, usd } from "@/lib/format";
import { ChartFrame } from "./ui";

const AXIS = {
  stroke: "#3d485f",
  tick: { fill: "#64708a", fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: "#2a3346" },
} as const;

const GRID = { stroke: "#1c2333", strokeDasharray: "2 4" } as const;

function TooltipShell({
  label,
  rows,
}: {
  label: string;
  rows: { key: string; value: string; color?: string }[];
}) {
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-850/95 px-3 py-2 shadow-xl backdrop-blur">
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-200">
        {label}
      </div>
      {rows.map((r) => (
        <div
          key={r.key}
          className="flex items-center justify-between gap-6 text-[11.5px]"
        >
          <span className="flex items-center gap-1.5 text-ink-400">
            {r.color && (
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: r.color }}
              />
            )}
            {r.key}
          </span>
          <span className="tnum text-ink-100">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Survival fan chart                                                  */
/* ------------------------------------------------------------------ */

/**
 * The headline chart. The shaded bands are the 5–95 and 25–75 percentile
 * ranges of simulated account equity; the solid line is the median path; the
 * dashed line is the probability the account has NOT yet breached the ruin
 * threshold by that day.
 *
 * Showing the fan rather than a single expected path is the point: the median
 * outcome of a leveraged book is often fine, and the distribution around it is
 * what actually decides whether you are still trading next month.
 */
export function SurvivalChart({ report }: { report: SentinelReport }) {
  const data = report.survival.curve.map((c) => ({
    day: c.day,
    p05: c.p05,
    p25: c.p25,
    p50: c.p50,
    p75: c.p75,
    p95: c.p95,
    // Stacked band helpers — recharts stacks by value, so we pass widths.
    band90: c.p95 - c.p05,
    band50: c.p75 - c.p25,
    survival: c.survival,
    ruinLine: 1 - report.survival.ruinThreshold,
  }));

  return (
    <ChartFrame height={300}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -6 }}>
          <defs>
            <linearGradient id="fan90" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7dd3fc" stopOpacity={0.16} />
              <stop offset="100%" stopColor="#7dd3fc" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="day"
            {...AXIS}
            label={{
              value: "days ahead",
              position: "insideBottom",
              offset: -2,
              fill: "#64708a",
              fontSize: 10,
            }}
          />
          <YAxis
            {...AXIS}
            domain={[0, "auto"]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            width={46}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <TooltipShell
                  label={`Day ${label}`}
                  rows={[
                    { key: "95th pct", value: pct(d.p95), color: "#7dd3fc" },
                    { key: "75th pct", value: pct(d.p75), color: "#38bdf8" },
                    { key: "median", value: pct(d.p50), color: "#e2e7f0" },
                    { key: "25th pct", value: pct(d.p25), color: "#38bdf8" },
                    { key: "5th pct", value: pct(d.p05), color: "#fb7185" },
                    {
                      key: "still alive",
                      value: pct(d.survival),
                      color: "#34d399",
                    },
                  ]}
                />
              );
            }}
          />
          {/* 5–95 band drawn as a stacked pair so the lower edge floats. */}
          <Area
            type="monotone"
            dataKey="p05"
            stackId="fan"
            stroke="none"
            fill="transparent"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="band90"
            stackId="fan"
            stroke="none"
            fill="url(#fan90)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="p25"
            stackId="inner"
            stroke="none"
            fill="transparent"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="band50"
            stackId="inner"
            stroke="none"
            fill="#38bdf8"
            fillOpacity={0.16}
            isAnimationActive={false}
          />
          <ReferenceLine
            y={1 - report.survival.ruinThreshold}
            stroke="#fb7185"
            strokeDasharray="4 4"
            strokeOpacity={0.7}
            label={{
              value: `ruin: ${pct(report.survival.ruinThreshold)} drawdown`,
              fill: "#fb7185",
              fontSize: 10,
              position: "insideBottomLeft",
            }}
          />
          <ReferenceLine y={1} stroke="#3d485f" strokeDasharray="2 3" />
          <Line
            type="monotone"
            dataKey="p50"
            stroke="#e2e7f0"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="survival"
            stroke="#34d399"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Liquidation cascade                                                 */
/* ------------------------------------------------------------------ */

export function CascadeChart({ report }: { report: SentinelReport }) {
  const data = report.cascade.ladder.map((r) => ({
    move: r.benchmarkMove,
    moveLabel: `${(r.benchmarkMove * 100).toFixed(1)}%`,
    equityPct: Math.max(0, r.equityPct),
    liquidatedCount: r.liquidatedCount,
  }));

  return (
    <ChartFrame height={300}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -6 }}>
          <defs>
            <linearGradient id="cascadeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
              <stop offset="55%" stopColor="#fbbf24" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#fb7185" stopOpacity={0.28} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="move"
            {...AXIS}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            label={{
              value: `${report.benchmarkSymbol} move`,
              position: "insideBottom",
              offset: -2,
              fill: "#64708a",
              fontSize: 10,
            }}
          />
          <YAxis
            {...AXIS}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            width={46}
            domain={[0, 1.05]}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <TooltipShell
                  label={`${report.benchmarkSymbol} ${d.moveLabel}`}
                  rows={[
                    { key: "equity remaining", value: pct(d.equityPct), color: "#34d399" },
                    {
                      key: "positions liquidated",
                      value: String(d.liquidatedCount),
                      color: "#fb7185",
                    },
                  ]}
                />
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="equityPct"
            stroke="#7dd3fc"
            strokeWidth={2}
            fill="url(#cascadeFill)"
            isAnimationActive={false}
          />
          {report.cascade.points.map((p) => (
            <ReferenceDot
              key={p.benchmarkMove}
              x={p.benchmarkMove}
              y={Math.max(0, p.equityPctAfter)}
              r={4}
              fill="#fb7185"
              stroke="#06080d"
              strokeWidth={1.5}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Risk contribution: exposure share vs tail-risk share                */
/* ------------------------------------------------------------------ */

/**
 * Two bars per asset, deliberately. The gap between "share of my money" and
 * "share of my tail losses" is the actionable number, and it is invisible in
 * the allocation pie chart every other portfolio tool leads with.
 */
export function ContributionChart({ report }: { report: SentinelReport }) {
  const data = report.contributions.map((c) => ({
    symbol: c.symbol,
    exposure: c.exposureShare,
    tail: c.esShare,
  }));

  return (
    <ChartFrame height={Math.max(200, data.length * 46 + 40)}>
      <ResponsiveContainer>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          barGap={2}
        >
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis
            type="number"
            {...AXIS}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          />
          <YAxis
            type="category"
            dataKey="symbol"
            {...AXIS}
            width={54}
            tick={{ fill: "#b9c2d4", fontSize: 11, fontWeight: 600 }}
          />
          <Tooltip
            cursor={{ fill: "#131926" }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <TooltipShell
                  label={String(label)}
                  rows={[
                    { key: "share of exposure", value: pct(d.exposure), color: "#64708a" },
                    { key: "share of tail loss", value: pct(d.tail), color: "#fb7185" },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="exposure" fill="#3d485f" radius={[0, 3, 3, 0]} isAnimationActive={false} />
          <Bar dataKey="tail" radius={[0, 3, 3, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell
                key={d.symbol}
                fill={d.tail > d.exposure + 0.08 ? "#fb7185" : "#7dd3fc"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Loss distribution                                                   */
/* ------------------------------------------------------------------ */

export function DistributionChart({ report }: { report: SentinelReport }) {
  const data = report.pnlHistogram;
  const var99 = -report.var99.historical;
  const es99 = -report.var99.expectedShortfall;

  return (
    <ChartFrame height={230}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -6 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis
            dataKey="bin"
            {...AXIS}
            tickFormatter={(v: number) => usd(v, { compact: true })}
          />
          <YAxis {...AXIS} width={34} />
          <Tooltip
            cursor={{ fill: "#131926" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as { bin: number; count: number };
              return (
                <TooltipShell
                  label={`Daily P&L ≈ ${usd(d.bin)}`}
                  rows={[{ key: "days", value: String(d.count) }]}
                />
              );
            }}
          />
          <ReferenceLine
            x={var99}
            stroke="#fbbf24"
            strokeDasharray="4 3"
            label={{ value: "VaR 99", fill: "#fbbf24", fontSize: 10, position: "top" }}
          />
          <ReferenceLine
            x={es99}
            stroke="#fb7185"
            strokeDasharray="4 3"
            label={{ value: "ES 99", fill: "#fb7185", fontSize: 10, position: "top" }}
          />
          <Bar dataKey="count" radius={[2, 2, 0, 0]} isAnimationActive={false}>
            {data.map((d) => (
              <Cell
                key={d.bin}
                fill={
                  d.bin <= es99 ? "#fb7185" : d.bin < 0 ? "#64708a" : "#34d399"
                }
                fillOpacity={0.75}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Drawdown back-cast                                                  */
/* ------------------------------------------------------------------ */

export function DrawdownChart({ report }: { report: SentinelReport }) {
  const data = report.drawdownSeries.map((d) => ({
    date: new Date(d.timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    drawdown: d.drawdown,
    equityIndex: d.equityIndex,
  }));

  return (
    <ChartFrame height={230}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -6 }}>
          <defs>
            <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fb7185" stopOpacity={0.05} />
              <stop offset="100%" stopColor="#fb7185" stopOpacity={0.35} />
            </linearGradient>
          </defs>
          <CartesianGrid {...GRID} />
          <XAxis dataKey="date" {...AXIS} minTickGap={40} />
          <YAxis
            {...AXIS}
            width={46}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <TooltipShell
                  label={String(label)}
                  rows={[
                    { key: "drawdown", value: pct(d.drawdown), color: "#fb7185" },
                    { key: "equity index", value: num(d.equityIndex, 3), color: "#7dd3fc" },
                  ]}
                />
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="drawdown"
            stroke="#fb7185"
            strokeWidth={1.5}
            fill="url(#ddFill)"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------------ */
/* Correlation regime heatmaps                                         */
/* ------------------------------------------------------------------ */

function Heatmap({
  symbols,
  matrix,
  caption,
}: {
  symbols: string[];
  matrix: number[][];
  caption: string;
}) {
  if (matrix.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[11px] font-medium tracking-[0.12em] text-ink-400 uppercase">
        {caption}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-[10.5px]">
          <thead>
            <tr>
              <th className="w-10" />
              {symbols.map((s) => (
                <th
                  key={s}
                  className="px-1 pb-1 text-center font-medium text-ink-400"
                >
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {symbols.map((rowSymbol, i) => (
              <tr key={rowSymbol}>
                <td className="pr-1.5 text-right font-medium text-ink-400">
                  {rowSymbol}
                </td>
                {symbols.map((colSymbol, j) => {
                  const v = matrix[i]?.[j] ?? 0;
                  return (
                    <td
                      key={colSymbol}
                      className="tnum rounded-[3px] px-1 py-1.5 text-center text-ink-100"
                      style={{ background: correlationColor(v) }}
                      title={`${rowSymbol} / ${colSymbol}: ${v.toFixed(3)}`}
                    >
                      {i === j ? "—" : v.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RegimeHeatmaps({ report }: { report: SentinelReport }) {
  const { regimes, benchmarkSymbol } = report;

  if (regimes.calm.length === 0) {
    return (
      <p className="text-[13px] text-ink-400">
        Not enough observations in each regime to split the correlation matrix.
        Add a second position, or widen the lookback window.
      </p>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Heatmap
        symbols={regimes.symbols}
        matrix={regimes.calm}
        caption={`Calm regime · ${regimes.calmDays} lowest-vol days`}
      />
      <Heatmap
        symbols={regimes.symbols}
        matrix={regimes.stressed}
        caption={`Stressed regime · ${regimes.stressedDays} highest-vol ${benchmarkSymbol} days`}
      />
    </div>
  );
}
