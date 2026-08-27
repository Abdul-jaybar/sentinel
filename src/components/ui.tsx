"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  aside,
  children,
  className,
  dense,
}: {
  title?: string;
  subtitle?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <section
      className={clsx(
        "rounded-xl border border-ink-700/70 bg-ink-900/60 backdrop-blur-sm",
        className,
      )}
    >
      {(title || aside) && (
        <header className="flex items-start justify-between gap-4 border-b border-ink-700/60 px-5 py-3.5">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[13px] font-semibold tracking-[0.14em] text-ink-200 uppercase">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">
                {subtitle}
              </p>
            )}
          </div>
          {aside && <div className="shrink-0">{aside}</div>}
        </header>
      )}
      <div className={dense ? "p-0" : "p-5"}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  size = "md",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "safe" | "warn" | "crit" | "info";
  size?: "sm" | "md" | "lg";
}) {
  const toneClass = {
    neutral: "text-ink-100",
    safe: "text-signal-safe",
    warn: "text-signal-warn",
    crit: "text-signal-crit",
    info: "text-signal-info",
  }[tone];

  const sizeClass = {
    sm: "text-lg",
    md: "text-2xl",
    lg: "text-4xl",
  }[size];

  return (
    <div>
      <div className="text-[10.5px] font-medium tracking-[0.16em] text-ink-400 uppercase">
        {label}
      </div>
      <div className={clsx("tnum mt-1.5 font-semibold", sizeClass, toneClass)}>
        {value}
      </div>
      {sub && <div className="mt-1 text-[12px] text-ink-400">{sub}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "safe" | "warn" | "crit" | "info";
}) {
  const tones = {
    neutral: "border-ink-600 bg-ink-800 text-ink-300",
    safe: "border-signal-safe/40 bg-signal-safe/10 text-signal-safe",
    warn: "border-signal-warn/40 bg-signal-warn/10 text-signal-warn",
    crit: "border-signal-crit/40 bg-signal-crit/10 text-signal-crit",
    info: "border-signal-info/40 bg-signal-info/10 text-signal-info",
  }[tone];

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium tracking-wide",
        tones,
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const variants = {
    default:
      "border-ink-600 bg-ink-800 text-ink-200 hover:bg-ink-700 hover:text-ink-100",
    primary:
      "border-signal-accent/50 bg-signal-accent/15 text-signal-accent hover:bg-signal-accent/25",
    ghost:
      "border-transparent bg-transparent text-ink-400 hover:bg-ink-800 hover:text-ink-200",
    danger:
      "border-signal-crit/40 bg-signal-crit/10 text-signal-crit hover:bg-signal-crit/20",
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        variants,
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Small labelled note used to state a model limitation next to its output. */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 border-l-2 border-ink-600 pl-3 text-[11.5px] leading-relaxed text-ink-400">
      {children}
    </p>
  );
}

export function ChartFrame({
  height = 260,
  children,
}: {
  height?: number;
  children: ReactNode;
}) {
  return (
    <div style={{ width: "100%", height }} className="min-w-0">
      {children}
    </div>
  );
}
