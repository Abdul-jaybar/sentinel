# Contributing

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

No environment variables are required.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

CI runs all four on every push and pull request. A red build is not merged.

## Where things live

The repository has a hard split, and it is worth respecting:

- **`src/lib/risk/`** — the quantitative engine. Pure functions, zero runtime
  dependencies, no React, no `fetch`, no `Date.now()` inside a calculation.
  Everything in here is unit-testable without a browser or a network, and it
  stays that way.
- **`src/lib/market/`** — everything that talks to the outside world, plus the
  three-tier data fallback.
- **`src/app/api/`** — thin route handlers. They validate input with zod, call
  the engine, and serialise. No arithmetic.
- **`src/components/`** — presentation. No risk logic; if a component is doing
  a calculation that belongs in `lib/risk`, move it.

## Standards for the engine

**Every estimator needs a known-answer test.** Not a snapshot of what the code
currently returns — a value derived independently, from a published table or a
closed form worked out by hand. A test that asserts the code agrees with itself
proves nothing. `tests/stats.test.ts` and `tests/backtest.test.ts` are the
reference for what this looks like.

**Degenerate input returns a boring answer, never `NaN`.** An empty series, a
single observation, a zero-variance asset, a half-filled portfolio: all of them
produce a report, not a crash and not `NaN%` on screen.

**No new runtime dependency in `src/lib/risk/`** without a strong argument. The
point of implementing Acklam's inverse normal CDF, the Jacobi eigensolver and
the stationary bootstrap by hand is that every number in the output can be
defended line by line. A maths library would make that harder, not easier.

**If a number is an approximation, the type says so.** The `provenance` field on
a stress scenario exists because an assumed shock and a measured return must
never be indistinguishable downstream. Follow that pattern rather than adding a
comment.

**Model limitations are documented next to their output**, not only in the
README. If a change makes the model wrong in a new way, the UI says so too.

## Data

`src/data/reference-history.json` is committed on purpose. Regenerate it with:

```bash
npm run fetch:history
```

Commit the result in its own commit, with the date range in the message. A
stress scenario that silently changes because an upstream API backfilled a
candle is not a stress scenario.
