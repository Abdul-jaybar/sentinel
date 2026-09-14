# GitHub setup pack

Everything needed to publish this repository, in one place.

**Important:** the `sentinel` folder you unzipped **is already a complete git
repository** with three commits of history in it. Nothing needs to be
reconstructed, recreated, or re-uploaded file by file. The only step left is
pointing it at a GitHub remote and pushing.

If you are handing this to another tool or assistant: what it needs is the
**folder**, not a description of the folder. No AI assistant can create a repo
under your GitHub account without a GitHub credential you grant it directly —
if one offers to, it is going to ask you to run these same commands anyway.

---

## Repository metadata

Use these exact values when creating the repo.

| Field | Value |
|---|---|
| **Name** | `sentinel` |
| **Visibility** | Public |
| **Description** | Survival analysis for leveraged crypto portfolios — block-bootstrap Monte Carlo, regime-split correlation, and an out-of-sample backtest of its own model. |
| **Website** | your Vercel URL, once deployed |
| **Topics** | `risk-management` `monte-carlo` `quantitative-finance` `value-at-risk` `backtesting` `typescript` `nextjs` `bootstrap-resampling` `expected-shortfall` `model-validation` |

Do **not** let GitHub initialise the repo with a README, `.gitignore`, or
licence. All three already exist here, and adding them remotely creates a
divergent history that makes your first push fail.

---

## Before you push — do these in order

```bash
cd sentinel
npm install
```

**1. Verify it's green.** CI runs exactly these four, and a red badge on a
pinned repo is worse than no badge at all.

```bash
npm run typecheck
npm run lint
npm test          # expect 93 passing
npm run build
```

**2. Load the real dataset.** This is the step that matters most and the one
easiest to skip.

```bash
npm run fetch:history
git add src/data/reference-history.json
git commit -m "Add reference dataset: real daily closes 2020-01-01 to $(date +%Y-%m-%d)"
```

Until that file holds real data, every historical stress scenario is badged
`assumed` rather than `measured`, and the validation panel has months of runway
instead of years. It takes about two minutes on CoinGecko's free tier.

**3. Look at it once.**

```bash
npm run dev     # http://localhost:3000
```

Load a preset, click **Run validation**, and read what it says — so you are not
seeing your own results for the first time in an interview.

---

## Push

With the GitHub CLI (`brew install gh`, or cli.github.com):

```bash
gh auth login
gh repo create sentinel --public --source=. --remote=origin --push
```

Without it — create an empty repo at github.com/new using the metadata above,
then:

```bash
git remote add origin https://github.com/abdullahnoaman/sentinel.git
git branch -M main
git push -u origin main
```

---

## Immediately after

1. **Set the About section.** Gear icon, right-hand side of the repo page.
   Paste the description and topics from the table above, and tick "Releases"
   and "Packages" off — they are empty and add noise.
2. **Deploy.** vercel.com/new → import `sentinel` → Deploy. Change no settings;
   Next.js is detected automatically. Put the resulting URL in the About
   section's Website field.
3. **Pin the repo** on your GitHub profile (profile → Customize your pins).
4. **Check the CI badge is green** before you send the link anywhere.
5. **Add the links** to your resume and your personal site.

---

## What's in here

```
src/lib/risk/        the quantitative engine — pure, dependency-free TypeScript
  backtest.ts        Kupiec, Christoffersen, walk-forward calibration
  survival.ts        stationary block-bootstrap Monte Carlo
  regime.ts          volatility-regime correlation split, effective bets
  var.ts             three VaR estimators, Euler ES attribution
  prescribe.ts       ranked de-risking search
  matrix.ts          Jacobi eigenvalues, Cholesky with shrinkage
  stats.ts           every primitive, hand-written and unit-tested
src/lib/market/      three-tier data layer: live, committed, synthetic
src/app/api/         thin route handlers — validate, call engine, serialise
src/components/      presentation only, no risk logic
tests/               93 known-answer tests
scripts/             fetch-history.mjs — builds the committed dataset
```

`CONTRIBUTING.md` explains the standards the engine is held to.
`DEPLOY.md` covers deployment and troubleshooting in more detail.

---

## If a push is rejected

**"non-fast-forward"** — GitHub initialised the repo with a README. Either
delete and recreate it empty, or `git pull --rebase origin main` then push.

**"repository not found"** — the remote URL has the wrong username in it.
Check with `git remote -v` and fix with `git remote set-url origin <correct>`.

**"Permission denied (publickey)"** — you are on the SSH URL without SSH keys
set up. Switch to HTTPS: `git remote set-url origin https://github.com/abdullahnoaman/sentinel.git`
