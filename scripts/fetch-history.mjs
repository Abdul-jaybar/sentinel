#!/usr/bin/env node
/**
 * Build the bundled reference dataset.
 *
 * Sentinel ships with a synthetic fallback so the app never shows a blank page
 * when a free API rate-limits. Synthetic data is fine for keeping the UI alive;
 * it is NOT fine as the basis for a historical stress scenario or a calibration
 * test, both of which are claims about what really happened.
 *
 * This script fetches real daily closes from CoinGecko and writes them to
 * src/data/reference-history.json, which is committed to the repository. Once
 * that file has real data in it:
 *
 *   - every stress scenario whose window the data covers flips from
 *     `assumed` (a benchmark shock propagated by beta) to `measured`
 *     (the per-asset return that actually occurred), and
 *   - the walk-forward validation runs over years rather than months.
 *
 * Usage:
 *   npm run fetch:history                    # default coins, from 2020-01-01
 *   npm run fetch:history -- --days 1500
 *   npm run fetch:history -- --coins bitcoin,ethereum,solana
 *
 * A COINGECKO_API_KEY in the environment is used if present. Without one the
 * free tier applies and the script paces itself accordingly; a full fetch of
 * ten coins takes a couple of minutes.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src/data/reference-history.json");

const DEFAULT_COINS = [
  ["bitcoin", "BTC"],
  ["ethereum", "ETH"],
  ["solana", "SOL"],
  ["ripple", "XRP"],
  ["cardano", "ADA"],
  ["avalanche-2", "AVAX"],
  ["chainlink", "LINK"],
  ["dogecoin", "DOGE"],
  ["polkadot", "DOT"],
  ["uniswap", "UNI"],
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const days = Number(arg("days", "2400"));
const coinsArg = arg("coins", null);
const coins = coinsArg
  ? coinsArg.split(",").map((c) => {
      const spec = DEFAULT_COINS.find(([id]) => id === c.trim());
      return spec ?? [c.trim(), c.trim().slice(0, 4).toUpperCase()];
    })
  : DEFAULT_COINS;

const apiKey = process.env.COINGECKO_API_KEY;
const base = apiKey
  ? "https://pro-api.coingecko.com/api/v3"
  : "https://api.coingecko.com/api/v3";

const now = Math.floor(Date.now() / 1000);
const from = now - days * 86400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch with bounded retry and exponential backoff. 429 is expected on free tier. */
async function fetchJson(url, attempt = 0) {
  const headers = apiKey ? { "x-cg-pro-api-key": apiKey } : {};
  const res = await fetch(url, { headers });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`${res.status} after 5 attempts: ${url}`);
    const wait = Math.min(60_000, 2000 * 2 ** attempt);
    process.stderr.write(`  ${res.status}, retrying in ${wait / 1000}s\n`);
    await sleep(wait);
    return fetchJson(url, attempt + 1);
  }

  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

/**
 * CoinGecko returns daily granularity automatically for ranges over 90 days,
 * but the points land on irregular intra-day timestamps. Snapping to UTC
 * midnight and keeping the LAST observation for each day gives a clean daily
 * close series — which is what every downstream estimator assumes it has.
 */
function toDailyCloses(prices) {
  const byDay = new Map();
  for (const [ts, price] of prices) {
    if (!Number.isFinite(price) || price <= 0) continue;
    const day = Math.floor(ts / 86_400_000);
    byDay.set(day, price);
  }
  const daysSorted = [...byDay.keys()].sort((a, b) => a - b);
  return {
    timestamps: daysSorted.map((d) => d * 86_400_000),
    prices: daysSorted.map((d) => byDay.get(d)),
  };
}

const series = [];
let failures = 0;

for (const [coinId, symbol] of coins) {
  const url = `${base}/coins/${coinId}/market_chart/range?vs_currency=usd&from=${from}&to=${now}`;
  process.stdout.write(`${symbol.padEnd(6)} `);

  try {
    const json = await fetchJson(url);
    const { timestamps, prices } = toDailyCloses(json.prices ?? []);

    if (timestamps.length < 60) {
      process.stdout.write(`skipped — only ${timestamps.length} daily closes\n`);
      failures += 1;
      continue;
    }

    series.push({ coinId, symbol, timestamps, prices });
    const first = new Date(timestamps[0]).toISOString().slice(0, 10);
    const last = new Date(timestamps.at(-1)).toISOString().slice(0, 10);
    process.stdout.write(`${timestamps.length} closes  ${first} → ${last}\n`);
  } catch (err) {
    process.stdout.write(`FAILED — ${err.message}\n`);
    failures += 1;
  }

  // Free tier is roughly 10-30 calls/minute. Pace rather than get rate-limited.
  if (!apiKey) await sleep(6000);
}

if (series.length === 0) {
  process.stderr.write("\nNo series fetched. Dataset not written.\n");
  process.exit(1);
}

const payload = {
  generatedAt: Date.now(),
  source: "coingecko",
  note: "Daily UTC closes. Regenerate with `npm run fetch:history`.",
  series,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(payload)}\n`);

const allDays = series.flatMap((s) => s.timestamps);
const span = {
  first: new Date(Math.min(...allDays)).toISOString().slice(0, 10),
  last: new Date(Math.max(...allDays)).toISOString().slice(0, 10),
};

process.stdout.write(
  `\nWrote ${series.length} series (${span.first} → ${span.last}) to src/data/reference-history.json` +
    `${failures > 0 ? `, ${failures} failed` : ""}\n` +
    `Commit it: the stress scenarios and the validation panel both read from it.\n`,
);
