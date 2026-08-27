export function usd(value: number, opts: { compact?: boolean } = {}): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (opts.compact) {
    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 10_000) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  }
  return `${sign}$${abs.toLocaleString("en-US", {
    maximumFractionDigits: abs < 10 ? 2 : 0,
    minimumFractionDigits: 0,
  })}`;
}

export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function signedPct(value: number, digits = 1): string {
  const s = value > 0 ? "+" : "";
  return `${s}${(value * 100).toFixed(digits)}%`;
}

export function price(value: number): string {
  if (value >= 1000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(3)}`;
}

export function num(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

/** Colour ramp for risk levels: low = green, high = red. */
export function riskColor(value: number, thresholds: [number, number]): string {
  if (value >= thresholds[1]) return "var(--color-signal-crit)";
  if (value >= thresholds[0]) return "var(--color-signal-warn)";
  return "var(--color-signal-safe)";
}

/** Diverging colour for a correlation cell in [-1, 1]. */
export function correlationColor(r: number): string {
  const clamped = Math.max(-1, Math.min(1, r));
  if (clamped >= 0) {
    // 0 -> transparent, 1 -> hot
    const a = 0.08 + clamped * 0.75;
    return `rgba(251, 113, 133, ${a.toFixed(3)})`;
  }
  const a = 0.08 + Math.abs(clamped) * 0.6;
  return `rgba(96, 165, 250, ${a.toFixed(3)})`;
}
