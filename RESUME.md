# Using Sentinel on your resume and in interviews

This file is for you, not for the repo's users. Delete it before making the repo public if you'd rather it not be there — though leaving it does no harm.

---

## Resume bullets

Pick two or three. They are written to survive a recruiter skim *and* a technical follow-up, which means every claim in them is something the code actually does.

**Full-stack / SWE framing**

> **Sentinel** — Next.js 15, TypeScript, Recharts · [live demo] · [repo]
> - Built a portfolio risk platform that answers a question consumer crypto tools don't: the probability a leveraged account survives the next 30 days, via a stationary block-bootstrap Monte Carlo (2,000 paths, day-by-day liquidation logic) running server-side in ~300 ms.
> - Implemented the entire quantitative engine dependency-free in TypeScript — three VaR estimators, Euler expected-shortfall attribution, Jacobi eigendecomposition, Cholesky with shrinkage fallback — with 49 known-answer unit tests and CI on every push.
> - Designed the data layer for a rate-limited free API: TTL cache with request coalescing, bounded retry with exponential backoff, and a circuit breaker that cut cold-path latency from 4.6 s to 316 ms during upstream failure.

**Quant-dev framing**

> **Sentinel** — risk engine for leveraged crypto portfolios · [live demo] · [repo]
> - Identified and corrected a conditional-correlation bias (Boyer / Loretan–English) that causes the naive "measure correlation on the worst days" approach to report that diversification *improves* in a crash; switched to a volatility-regime split, surfacing a measured rise from 0.68 to 0.95 in a representative book.
> - Quantified diversification via exponential Shannon entropy of the correlation matrix's eigenvalue spectrum, showing a six-asset "diversified" book collapses from 2.7 to 1.3 effective independent bets under stress.
> - Built a prescription engine that re-simulates the portfolio under every candidate de-risking action and ranks them by ruin-probability reduction per unit of capital, against common random numbers to isolate the treatment effect.

---

## The 30-second pitch

> Every crypto portfolio tracker tells you what your portfolio is worth. None of them tell you whether it survives. Leveraged books don't die because one asset moved — they die because six positions that looked independent moved together and hit their maintenance levels at the same time. Sentinel measures that specific failure: it splits your correlations into calm and stressed regimes, bootstraps thousands of forward paths from the real joint return history, finds the exact benchmark move where positions liquidate *simultaneously*, and then tells you the single cheapest trade that meaningfully improves your odds.

## The 2-minute demo path

1. Load the **"diversified alt book"** preset. Six tickers, four narratives.
2. Point at the verdict bar: *"1.28 independent bets."* Six positions, one bet.
3. Scroll to **correlation regimes**. Two heatmaps side by side — calm is pink, stressed is nearly solid red. "This is the whole product in one picture."
4. Scroll to the **cascade chart**. Red dots. "Each of those is a forced close. Per-position liquidation prices never show you that they cluster."
5. Land on **"what to do about it."** "It re-ran the entire simulation under every candidate action and ranked them by how much ruin probability you remove per dollar. That's the answer nobody else gives you."

---

## Questions you should be ready for

**"Why block bootstrap instead of a Gaussian simulation?"**
Three reasons. It resamples whole days across all assets at once, so joint tail dependence survives — a correlation matrix throws that away by construction. Contiguous blocks preserve volatility clustering, and it's the consecutive bad days that liquidate accounts, not independent draws. And it can't produce a return the market never produced. The cost is that it can't produce unprecedented ones either, so the left tail is a floor on the risk, not a ceiling — which the UI says explicitly.

**"Isn't measuring correlation on bad days circular or biased?"**
Yes, and that's the most interesting bug I fixed. Conditioning on one tail of the factor truncates the factor's variance in the subsample, which shrinks the systematic share of variance and biases correlation *downward*. My first implementation reported that diversification improved in a crash. I switched to splitting on the benchmark's rolling realised volatility — two-sided, so no truncation — and the effect reversed to what theory and every crisis actually show.

**"Why no math library?"**
So I can defend every number. Acklam's inverse normal CDF, the Cornish-Fisher expansion, Jacobi eigenvalues, Cholesky with a shrinkage fallback — each is about thirty lines and each is unit-tested against a value I derived independently rather than by running my own code and pasting the output. If someone asks me why the 99% VaR is what it is, there's no black box in the path.

**"What would you build next?"**
Intraday data, because daily stepping understates liquidation risk — being wrong for four hours is enough to be closed out. Then cross-margin modelling, since I currently assume isolated margin, and a funding-rate term, since carry is a real drag on a levered book that I ignore entirely.

**"What's the weakest part?"**
The stress scenarios use hand-specified benchmark shocks with a beta amplifier rather than actual historical returns from those windows — I didn't have a reliable free source for point-in-time data going back to 2020 for every alt. It's a reasonable approximation and it's labelled as one, but it's the part I'd replace first with real data.

---

## Before you apply

- [ ] Deploy it and put the live URL in the resume line — a link that loads beats any bullet.
- [ ] Pin the repo on your GitHub profile.
- [ ] Add a screenshot or short GIF to the top of the README. Recruiters skim; a picture of the regime heatmaps does more than a paragraph.
- [ ] Make sure the CI badge is green.
- [ ] Actually run through the 2-minute demo out loud once. It's a different skill from building it.
