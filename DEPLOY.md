# Deploying

Sentinel is a standard Next.js app, so it deploys to Vercel with no configuration.

## Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import this repository.
2. Leave the settings as they are. Vercel detects Next.js and fills in the build command and output directory.
3. Click **Deploy**.

After a minute or two you'll have a URL like `sentinel-yourname.vercel.app`. Every push to `main` redeploys it.

## Environment variables

Both are optional. Add them under **Settings → Environment Variables** and redeploy.

| Variable | What it does |
|---|---|
| `COINGECKO_API_KEY` | A CoinGecko API key raises the rate limit on live prices. Without it the app uses the free tier, and the cache, circuit breaker and committed dataset cover rate limits. |
| `ANTHROPIC_API_KEY` | Turns on the follow-up question box. The written risk assessment doesn't need it. |

## Before you push

CI runs these four on every push and pull request, so run them locally first:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Troubleshooting

**The build fails on Vercel but works locally.** It's almost always a type error. Run `npm run typecheck`, which uses the same compiler settings as CI and Vercel.

**The site shows the committed dataset instead of live prices.** CoinGecko is rate-limiting the deployment's IP. The app is built to keep working when that happens, and it tells you on screen. Adding a `COINGECKO_API_KEY` fixes it.

**`/api/risk` times out.** The simulation takes around 300 ms once warm, so a timeout usually means the upstream price request is hanging. The route's `maxDuration` is 60 seconds, which is within the Hobby plan limit.

**The validation panel says "Not enough history to validate."** The 120-day training window needs more data after it to score. Run `npm run fetch:history`, commit the dataset, and redeploy.

**`npm run fetch:history` fails with 403 or 429.** Coinbase allows around 10 requests a second, and the script stays well under that. A 403 usually means a network proxy or firewall is blocking `api.exchange.coinbase.com`. If you run the script behind a proxy on Node 22+, set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses it.
