#!/usr/bin/env node
/**
 * Build the bundled reference dataset.
 *
 * The app has a synthetic fallback so the page never goes blank when a free
 * API rate-limits. Synthetic prices are fine for keeping the UI alive. They
 * are not fine for a historical stress scenario or a calibration test, since
 * both of those are claims about what really happened.
 *
 * This script downloads real daily closes and writes them to
 * src/data/reference-history.json, which is committed to the repo. Once that
 * file has real data in it:
 *
 *   - every stress scenario whose dates the data covers switches from
 *     `assumed` (a benchmark shock spread to each coin by its beta) to
 *     `measured` (the return each coin actually had), and
 *   - the walk-forward validation runs over years instead of months.
 *
 * Sources:
 *   coinbase   Coinbase Exchange public candles. No key needed, goes back to
 *              each coin's Coinbase listing date. Default.
 *   coingecko  Needs COINGECKO_API_KEY. The free CoinGecko tier only serves
 *              the last 365 days, which is too short for the 2020-2022
 *              scenarios, so it is only used when a paid key is set.
 *
 * Usage:
 *   npm run fetch:history
 *   npm run fetch:history -- --days 1500
 *   npm run fetch:history -- --coins bitcoin,ethereum,solana
 *   npm run fetch:history -- --source coingecko
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src/data/reference-history.json");

// [CoinGecko id, ticker]. The ticker doubles as the Coinbase product (BTC-USD).
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
const source = arg("source", apiKey ? "coingecko" : "coinbase");
if (source !== "coinbase" && source !== "coingecko") {
  process.stderr.write(`Unknown --source ${source}. Use coinbase or coingecko.\n`);
  process.exit(1);
}
const base = apiKey
  ? "https://pro-api.coingecko.com/api/v3"
  : "https://api.coingecko.com/api/v3";

const now = Math.floor(Date.now() / 1000);
const from = now - days * 86400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch with bounded retry and exponential backoff. 429 is expected on free tier. */
async function fetchJson(url, attempt = 0) {
  const headers =
    source === "coingecko" && apiKey
      ? { "x-cg-pro-api-key": apiKey }
      : { "User-Agent": "sentinel-fetch-history" };
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
 * CoinGecko gives daily points for ranges over 90 days, but they land on
 * uneven times of day. Snapping each point to its UTC day and keeping the last
 * one gives a clean one-close-per-day series, which is what every estimator
 * downstream expects.
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

async function fetchCoinGecko(coinId) {
  const url = `${base}/coins/${coinId}/market_chart/range?vs_currency=usd&from=${from}&to=${now}`;
  const json = await fetchJson(url);
  return toDailyCloses(json.prices ?? []);
}

/**
 * Coinbase returns at most 300 candles per request, newest first, as
 * [time, low, high, open, close, volume] with time at the start of the UTC
 * day. The close of day D is the price at midnight going into D+1, so it is
 * stamped there. That matches how CoinGecko's daily points are timed, and it
 * keeps the live feed and this file on the same calendar.
 */
async function fetchCoinbase(symbol) {
  const DAY = 86_400;
  const byDay = new Map();
  const today = Math.floor(now / DAY) * DAY;

  for (let start = Math.floor(from / DAY) * DAY; start < today; start += 300 * DAY) {
    const end = Math.min(start + 299 * DAY, today - DAY);
    const url =
      `https://api.exchange.coinbase.com/products/${symbol}-USD/candles` +
      `?granularity=86400&start=${new Date(start * 1000).toISOString()}` +
      `&end=${new Date(end * 1000).toISOString()}`;
    const candles = await fetchJson(url);
    for (const [time, , , , close] of candles) {
      // Skip today's candle: it hasn't closed yet.
      if (time >= today || !Number.isFinite(close) || close <= 0) continue;
      byDay.set(time / DAY + 1, close);
    }
    // Public limit is about 10 requests a second. Stay well under it.
    await sleep(250);
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
  process.stdout.write(`${symbol.padEnd(6)} `);

  try {
    const { timestamps, prices } =
      source === "coinbase"
        ? await fetchCoinbase(symbol)
        : await fetchCoinGecko(coinId);

    if (timestamps.length < 60) {
      process.stdout.write(`skipped, only ${timestamps.length} daily closes\n`);
      failures += 1;
      continue;
    }

    series.push({ coinId, symbol, timestamps, prices });
    const first = new Date(timestamps[0]).toISOString().slice(0, 10);
    const last = new Date(timestamps.at(-1)).toISOString().slice(0, 10);
    process.stdout.write(`${timestamps.length} closes  ${first} to ${last}\n`);
  } catch (err) {
    process.stdout.write(`FAILED: ${err.message}\n`);
    failures += 1;
  }

  // CoinGecko's free tier allows roughly 10-30 calls a minute. Pace instead of
  // getting rate-limited.
  if (source === "coingecko" && !apiKey) await sleep(6000);
}

if (series.length === 0) {
  process.stderr.write("\nNo series fetched. Dataset not written.\n");
  process.exit(1);
}

const payload = {
  generatedAt: Date.now(),
  source,
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
  `\nWrote ${series.length} series (${span.first} to ${span.last}) to src/data/reference-history.json` +
    `${failures > 0 ? `, ${failures} failed` : ""}\n` +
    `Commit it: the stress scenarios and the validation panel both read from it.\n`,
);
