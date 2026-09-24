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

The code is split into four areas, and each one has a clear job:

- **`src/lib/risk/`**: the quantitative engine. Pure functions, zero runtime
  dependencies, no React, no `fetch`, no `Date.now()` inside a calculation.
  Everything in here is unit-testable without a browser or a network, and it
  stays that way.
- **`src/lib/market/`**: everything that talks to the outside world, plus the
  three-tier data fallback.
- **`src/app/api/`**: thin route handlers. They validate input with zod, call
  the engine, and serialise. No arithmetic.
- **`src/components/`**: presentation. No risk logic; if a component is doing
  a calculation that belongs in `lib/risk`, move it.

## Standards for the engine

**Every estimator needs a known-answer test.** The expected value has to come
from somewhere other than the code: a published table, or a formula worked out
by hand. Copying whatever the code currently returns into the test only checks
that the code agrees with itself. `tests/stats.test.ts` and `tests/backtest.test.ts` are the
reference for what this looks like.

**Degenerate input returns a boring answer, never `NaN`.** An empty series, a
single observation, a zero-variance asset, a half-filled portfolio: all of them
produce a report, not a crash and not `NaN%` on screen.

**Avoid adding runtime dependencies to `src/lib/risk/`.** The inverse normal
CDF, the Jacobi eigensolver and the bootstrap are written by hand so that every
number can be traced line by line. A maths library would make that harder.

**If a number is an approximation, the type says so.** For example, stress
scenarios have a `provenance` field so an assumed shock can always be told
apart from a measured return. Use a field like that rather than a comment.

**Model limitations are documented next to their output**, not only in the
README. If a change makes the model wrong in a new way, the UI says so too.

## Data

`src/data/reference-history.json` is committed on purpose. Regenerate it with:

```bash
npm run fetch:history
```

It pulls daily closes from Coinbase (or CoinGecko, if `COINGECKO_API_KEY` is
set). Commit the result on its own, with the date range in the commit message,
so any change to the stress results can be traced to a data update.
