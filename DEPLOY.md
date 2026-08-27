# Getting Sentinel onto GitHub and Vercel

Two steps, about five minutes total. You need a GitHub account and a Vercel account (free tier is fine — sign into Vercel with GitHub so they're already linked).

---

## Step 1 — Push to GitHub

Unzip the project, open a terminal in the `sentinel` folder, and check it runs:

```bash
npm install
npm run dev
```

Open http://localhost:3000. You should see the dashboard with live prices. Stop the server with `Ctrl+C` when you're happy.

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
- Add the live URL to the resume line — see `RESUME.md`.

---

## If something goes wrong

**Build fails on Vercel but works locally.** Check the build log for a type error. Run `npm run typecheck` locally; it uses the exact same compiler settings CI and Vercel use.

**The site loads but shows "reference dataset" instead of live prices.** CoinGecko is rate-limiting your deployment's IP. This is expected behaviour, not a bug — the app is designed to stay useful when the feed is down, and it says so on screen. Adding a free `COINGECKO_API_KEY` fixes it.

**`/api/risk` times out.** The simulation runs in roughly 300 ms warm, so a timeout means the upstream fetch is hanging. `maxDuration` is already set to 60 s on that route, which is within the Hobby plan's limit.

**Push rejected as "non-fast-forward".** You let GitHub initialise the repo with a README. Either delete the repo and recreate it empty, or run `git pull --rebase origin main` and push again.
