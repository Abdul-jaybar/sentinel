"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";
import type { MarketAsset, Position, Venue } from "@/lib/types";
import { PRESETS, instantiate } from "@/lib/presets";
import { price as fmtPrice, usd } from "@/lib/format";
import { Badge, Button } from "./ui";

const VENUES: Venue[] = ["spot", "perp", "defi"];

function newId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function PositionEditor({
  positions,
  markets,
  onChange,
}: {
  positions: Position[];
  markets: MarketAsset[];
  onChange: (next: Position[]) => void;
}) {
  const [draftCoin, setDraftCoin] = useState("bitcoin");
  const [query, setQuery] = useState("");

  const marketMap = useMemo(
    () => Object.fromEntries(markets.map((m) => [m.coinId, m])),
    [markets],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? markets.filter(
          (m) =>
            m.symbol.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q),
        )
      : markets;
    return base.slice(0, 40);
  }, [markets, query]);

  useEffect(() => {
    if (filtered.length > 0 && !filtered.some((m) => m.coinId === draftCoin)) {
      setDraftCoin(filtered[0].coinId);
    }
  }, [filtered, draftCoin]);

  function update(id: string, patch: Partial<Position>) {
    onChange(positions.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function addPosition() {
    const asset = marketMap[draftCoin];
    if (!asset) return;
    // Default to roughly $5k of exposure so a new row produces a meaningful
    // number immediately rather than a zero row the user has to fix first.
    const quantity = Number((5000 / Math.max(asset.price, 1e-9)).toPrecision(4));
    onChange([
      ...positions,
      {
        id: newId(),
        coinId: asset.coinId,
        symbol: asset.symbol,
        quantity,
        entryPrice: asset.price,
        leverage: 1,
        venue: "spot",
      },
    ]);
  }

  const gross = positions.reduce((acc, p) => {
    const px = marketMap[p.coinId]?.price ?? p.entryPrice;
    return acc + Math.abs(p.quantity * px);
  }, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium tracking-[0.14em] text-ink-400 uppercase">
          Load a book
        </span>
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            onClick={() => onChange(instantiate(preset))}
            title={preset.thesis}
            className="rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1 text-[12px] text-ink-300 transition-colors hover:border-signal-accent/50 hover:bg-ink-700 hover:text-signal-accent"
          >
            <Wand2 className="mr-1.5 inline h-3 w-3" />
            {preset.name}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-700/70">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead>
            <tr className="border-b border-ink-700/70 bg-ink-850/60 text-[10.5px] tracking-[0.12em] text-ink-400 uppercase">
              <th className="px-3 py-2.5 text-left font-medium">Asset</th>
              <th className="px-3 py-2.5 text-right font-medium">Quantity</th>
              <th className="px-3 py-2.5 text-right font-medium">Entry</th>
              <th className="px-3 py-2.5 text-right font-medium">Mark</th>
              <th className="px-3 py-2.5 text-right font-medium">Leverage</th>
              <th className="px-3 py-2.5 text-left font-medium">Venue</th>
              <th className="px-3 py-2.5 text-right font-medium">Notional</th>
              <th className="px-3 py-2.5 text-right font-medium">Unreal.</th>
              <th className="w-10 px-2 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-3 py-8 text-center text-[13px] text-ink-400"
                >
                  No positions yet. Load a preset book above, or add one below.
                </td>
              </tr>
            )}
            {positions.map((p) => {
              const mark = marketMap[p.coinId]?.price ?? p.entryPrice;
              const notional = p.quantity * mark;
              const unreal = p.quantity * (mark - p.entryPrice);
              return (
                <tr
                  key={p.id}
                  className="border-b border-ink-700/40 last:border-0 hover:bg-ink-850/40"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink-100">
                        {p.symbol}
                      </span>
                      {p.quantity < 0 && <Badge tone="info">short</Badge>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={p.quantity}
                      step="any"
                      onChange={(e) =>
                        update(p.id, { quantity: Number(e.target.value) })
                      }
                      className="tnum w-24 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-right text-ink-100 outline-none focus:border-signal-accent/60"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={p.entryPrice}
                      step="any"
                      min={0}
                      onChange={(e) =>
                        update(p.id, { entryPrice: Number(e.target.value) })
                      }
                      className="tnum w-24 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-right text-ink-100 outline-none focus:border-signal-accent/60"
                    />
                  </td>
                  <td className="tnum px-3 py-2 text-right text-ink-300">
                    {fmtPrice(mark)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      value={p.leverage}
                      step="0.5"
                      min={1}
                      max={125}
                      onChange={(e) =>
                        update(p.id, {
                          leverage: Math.max(1, Number(e.target.value)),
                        })
                      }
                      className="tnum w-16 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-right text-ink-100 outline-none focus:border-signal-accent/60"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={p.venue}
                      onChange={(e) =>
                        update(p.id, { venue: e.target.value as Venue })
                      }
                      className="rounded border border-ink-600 bg-ink-900 px-2 py-1 text-ink-200 outline-none focus:border-signal-accent/60"
                    >
                      {VENUES.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="tnum px-3 py-2 text-right text-ink-200">
                    {usd(notional, { compact: true })}
                  </td>
                  <td
                    className="tnum px-3 py-2 text-right"
                    style={{
                      color: unreal >= 0 ? "var(--color-signal-safe)" : "var(--color-signal-crit)",
                    }}
                  >
                    {usd(unreal, { compact: true })}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() =>
                        onChange(positions.filter((q) => q.id !== p.id))
                      }
                      className="rounded p-1 text-ink-500 transition-colors hover:bg-ink-700 hover:text-signal-crit"
                      aria-label={`Remove ${p.symbol}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <label className="mb-1 block text-[10.5px] tracking-[0.14em] text-ink-400 uppercase">
            Search assets
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="BTC, solana, …"
            className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-1.5 text-[13px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-signal-accent/60"
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-[10.5px] tracking-[0.14em] text-ink-400 uppercase">
            Asset
          </label>
          <select
            value={draftCoin}
            onChange={(e) => setDraftCoin(e.target.value)}
            className="w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-1.5 text-[13px] text-ink-100 outline-none focus:border-signal-accent/60"
          >
            {filtered.map((m) => (
              <option key={m.coinId} value={m.coinId}>
                {m.symbol} · {m.name} ({fmtPrice(m.price)})
              </option>
            ))}
          </select>
        </div>
        <Button onClick={addPosition} variant="primary">
          <Plus className="h-3.5 w-3.5" />
          Add position
        </Button>
        <div className="ml-auto text-[12px] text-ink-400">
          Gross exposure{" "}
          <span className="tnum text-ink-100">{usd(gross, { compact: true })}</span>
        </div>
      </div>
    </div>
  );
}
