# Getting Sentinel onto GitHub and Vercel

Two steps, about five minutes total. You need a GitHub account and a Vercel account (free tier is fine — sign into Vercel with GitHub so they're already linked).

---

## Step 1 — Push to GitHub

Unzip the project, open a terminal in the `sentinel` folder, and check it runs:

```bash
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

All four must pass before you push — CI runs exactly these, and a red badge on a
pinned repo is worse than no badge. You should see **93 tests passing**.

Then start it:

```bash
npm run dev
```

Open http://localhost:3000. You should see the dashboard with live prices. Stop the server with `Ctrl+C` when you're happy.

### Do this before you push: load the real dataset

```bash
npm run fetch:history
```

This pulls about 2,400 daily closes per asset from CoinGecko back to 2020 and
writes `src/data/reference-history.json`. It takes a couple of minutes on the
free tier. Commit the file:

```bash
git add src/data/reference-history.json
git commit -m "Add reference dataset: daily closes 2020-01-01 to <today>"
```

This matters more than it looks. Until that file has real data in it:

- every historical stress scenario is badged **`assumed`** rather than
  **`measured`** — a beta-propagated approximation instead of what actually
  happened, and the UI says so honestly;
- the validation panel has only a few months of runway instead of years.

Running it is the difference between "I modelled the FTX collapse" and "I
measured it". Do it once, commit, and the claim on your resume is the stronger
one.

Now create the repo. The easiest path is the GitHub CLI (`brew install gh` on macOS, or [cli.github.com](https://cli.github.com)):

```bash
gh auth login
gh repo create sentinel --public --source=. --remote=origin --push
```

That creates the repository and pushes in one command.

**Without the CLI:** create an empty repository named `sentinel` at [github.com/new](https://github.com/new) — do *not* let it add a README, licence, or .gitignore — then run:

```bash
git remote add origin https://github.com/YOUR-USERNAME/sentinel.git
git branch -M main
git push -u origin main
```

The project already has a commit in it, so there's nothing to stage first.

---

## Step 2 — Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new).
2. Pick the `sentinel` repository and click **Import**.
3. Change nothing. Vercel detects Next.js and fills in the build command, output directory, and install command by itself.
4. Click **Deploy**.

About ninety seconds later you'll have a live URL like `sentinel-yourname.vercel.app`. Every future `git push` to `main` redeploys automatically.

### Optional environment variables

The app is fully functional without either of these. Add them under **Settings → Environment Variables** if you want them, then redeploy.

| Variable | What it does |
|---|---|
| `COINGECKO_API_KEY` | A free demo key from [coingecko.com/en/api](https://www.coingecko.com/en/api). Raises your rate limit. Without it the app uses the public tier, and the built-in cache, circuit breaker, and labelled fallback dataset handle the limits. |
| `ANTHROPIC_API_KEY` | Enables the "ask a follow-up" box only. The written risk assessment is generated deterministically by the app itself and does not need this. |

---

## After it's live

- Put the URL in the repo's **About** section (the gear icon on the right of the GitHub repo page) so it shows at the top.
- Pin the repo on your GitHub profile.
- Add the live URL to the resume line and to your personal site.
- Load a preset and click **Run validation** once, so you know what it says
  before someone asks you in an interview.

---

## If something goes wrong

**Build fails on Vercel but works locally.** Check the build log for a type error. Run `npm run typecheck` locally; it uses the exact same compiler settings CI and Vercel use.

**The site loads but shows "reference dataset" instead of live prices.** CoinGecko is rate-limiting your deployment's IP. This is expected behaviour, not a bug — the app is designed to stay useful when the feed is down, and it says so on screen. Adding a free `COINGECKO_API_KEY` fixes it.

**`/api/risk` times out.** The simulation runs in roughly 300 ms warm, so a timeout means the upstream fetch is hanging. `maxDuration` is already set to 60 s on that route, which is within the Hobby plan's limit.

**The validation panel says "Not enough history to validate."** The training
window needs 120 days plus enough left over to score. Run
`npm run fetch:history`, commit the dataset, and redeploy.

**`npm run fetch:history` returns 429s.** That's CoinGecko's free-tier rate
limit. The script already backs off and retries; let it run. A free demo API key
in `COINGECKO_API_KEY` makes it much faster.

**Push rejected as "non-fast-forward".** You let GitHub initialise the repo with a README. Either delete the repo and recreate it empty, or run `git pull --rebase origin main` and push again.
