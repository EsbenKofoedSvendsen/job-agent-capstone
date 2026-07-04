# Job Agent — an autonomous job-search concierge

**Track: Concierge Agents** · [Code](https://github.com/EsbenKofoedSvendsen/job-agent-capstone) · [Video](REPLACE_ME) · Live app: deployed 24/7 on Fly.io (password-protected — it holds my real résumé; the video shows it live)

## Why I built it

I'm a strategy/product professional job-hunting in New York. The honest shape
of that work: check ~70 company career pages, skim hundreds of postings,
almost all irrelevant, and try not to miss the two that matter — every day.
That's not a search problem, it's a monitoring problem, and monitoring is what
agents are for.

Job Agent is a single-user concierge that owns the grind end to end: it
scrapes ~70 sources on a weekday schedule, scores every new posting against my
résumé with a calibrated two-model cascade, keeps a three-tier board, and
emails me only when something scores 85+. I stopped checking career pages;
strong matches now find me.

The system was built entirely by **vibe coding** — every feature in this repo,
from the Playwright network-capture scraper to the SQL schema to the prompt
calibration, was specified in natural language and implemented conversationally
with an AI coding agent across ~2 weeks of sessions.

## How it works

![Architecture](https://raw.githubusercontent.com/EsbenKofoedSvendsen/job-agent-capstone/main/docs/architecture-v2.svg)

**Multi-agent cost cascade.** Four specialized model roles: a Haiku *extractor*
turns raw page text into structured jobs (only for browser-scraped sites — 9
ATS APIs are parsed deterministically); a Haiku *first-pass scorer* judges
every candidate in batches of 10 against a cached rubric; a Sonnet *judge*
gives a second opinion only on scores above 70; a Sonnet *tailor* rewrites my
résumé for a specific role on demand. An **MCP server** (`mcp-server/`)
exposes the whole system as tools to any MCP client.

**The data flywheel** is the part I'm proudest of. Three feedback loops make
the agent cheaper and smarter with age:

- *Reject cache* — every below-threshold posting is remembered, so boards that
  repost the same jobs daily cost tokens exactly once.
- *Prompt mining* — every judge override is logged with both models'
  reasonings. Mining 303 disagreements exposed one systematic first-pass bias
  (functional mismatches — HR, legal, engineering roles — parked at ~72 on
  "transferable skills"). Distilling the corrections into calibration anchors
  moved those exact cases to 15–18 on the first pass and eliminated ~70% of
  judge calls at the source.
- *Health & cost telemetry* — per-source status dots and a per-scrape cost
  line drive operational policy (browser-path sites scrape once daily; ATS
  APIs run every slot).

**Evaluation (Day 4) is built in, not bolted on:** JSON-schema-constrained
outputs, a score-test endpoint for golden probes, and a repeatable
Sonnet-arbitrated false-negative audit (last run: 1 borderline recovery in a
24-job sample, zero missed Tier-1s).

**Deployability (Day 5):** one Docker image on Fly.io, persistent SQLite
volume, self-healing scheduler with a single-flight lock and watchdog, and
cost accounting that turned a real $7.4/day token-budget blowout into a
sub-$1/day steady state — measured, not estimated, from the provider's usage
export.

## Course concepts demonstrated

1. **Multi-agent system** — extractor / scorer / judge / tailor cascade (code)
2. **MCP server** — five tools over the live agent (code)
3. **Memory & state / agent skills** — reject cache, disagreement log,
   source health; the agent provably improves with accumulated state (code)
4. **Security** — Basic Auth, secrets in env/Fly secrets, résumé never leaves
   the private volume, schema-constrained model output (code + video)
5. **Deployability** — 24/7 cloud deployment with observability and cost
   telemetry (video)

## What I'd build next

Batch-API scoring (50% cost), promoting the flakiest browser sources to
deterministic adapters, and a continuous 5% Sonnet audit sample to convert
false-negative checking from a manual exercise into a monitored metric.
