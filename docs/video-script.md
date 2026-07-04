# Video script — 2:00 max (judges stop watching at 2:00 sharp)

Record: screen capture (QuickTime/Loom) + voiceover. Practice once; the script
below reads at ~1:50 at a calm pace. Cut anything before adding anything.

| Time | On screen | Say |
|---|---|---|
| 0:00–0:12 | Montage: 4–5 career sites open in tabs, endless scrolling | "Job hunting in 2026 means checking seventy career pages a day and missing the one posting that mattered. So I stopped checking — and built an agent that does it for me." |
| 0:12–0:35 | Live dashboard: three-tier board, scroll Tier 1; click a job, show the score + reasoning in the drawer | "Job Agent scrapes about seventy company sources on a schedule and scores every posting against my résumé. Tier one is 'apply now' — each score comes with the model's reasoning. This week it surfaced these three at 88." |
| 0:35–0:55 | Architecture diagram (docs/architecture-v2.svg), cursor tracing the cascade | "Under the hood it's a multi-agent cost cascade: a small model extracts and scores everything in batches against a cached rubric; a stronger model gives a second opinion only on promising jobs; deterministic filters discard ninety percent of postings before a single token is spent." |
| 0:55–1:15 | Diagram flywheel column, then Settings page: source health dots | "The system improves itself: every disagreement between the two models is logged, and mining three hundred of them produced calibration anchors that cut the second-opinion calls by seventy percent. Rejected jobs are remembered — nothing is ever scored twice. And every source gets a live health dot." |
| 1:15–1:30 | MCP client (e.g. Claude Desktop) showing the job-agent tool list; one list_jobs call returning the board | "An MCP server exposes the whole agent as tools — any MCP client can query my board or score a posting conversationally." |
| 1:30–1:50 | Fly.io dashboard + logs with `[scrape] AI usage … est $` line; email digest in inbox | "It runs 24/7 on a five-dollar VM. Cost telemetry on every scrape caught a real budget blowout and drove it from seven dollars a day to under one. When something scores 85 or higher, it emails me. That's the whole point:" |
| 1:50–2:00 | Board, then title card: "Job Agent — vibe-coded end to end" | "…strong matches find me now. Every line of this system was vibe-coded — spec'd in plain language, built conversationally. Thanks for watching." |

## Shot checklist (capture before recording)

- [ ] Dashboard with a populated Tier 1 (open a job drawer for the reasoning)
- [ ] Settings page showing the source-health dots + legend
- [ ] docs/architecture-v2.svg full screen
- [ ] MCP: tool list + one call in Claude Desktop (or any MCP client)
- [ ] Fly dashboard (machine running) + `fly logs` showing an `[ai]`/`[scrape]` cost line
- [ ] The digest email in your inbox (search "new job match")

## Recording notes

- 1080p or higher; hide bookmarks bar; close notification centers.
- Blur/avoid: your API keys, the APP_PASSWORD, full résumé text on screen.
- Upload unlisted to YouTube; paste the link into the Kaggle Writeup.
