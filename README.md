# Job Agent — Local

A self-contained version of your HireMe pipeline. One Node server, a local
SQLite database, a real Chromium browser for scraping, and any one AI key
(Anthropic or OpenAI). Runs locally or hosted (see Fly.io section).

It does two things your old app couldn't:

1. **Scrapes fast.** The cloud version was throttled to concurrency `2` and one
   source at a time to survive Cloudflare's request timeout, waited a fixed
   2.5 s on every page, and made a separate AI call to score *every single job*.
   This version runs with no such timeout, so it scrapes many sources
   and pages in parallel, uses smart waits instead of fixed sleeps, blocks
   images/fonts/CSS, dedupes in memory, and **scores jobs in batches** (10 per
   AI call by default). In practice that's the difference between minutes and
   tens of minutes.
2. **Keeps your data.** An importer loads your existing Supabase export
   (142 jobs, your profile, status history) straight into the local database.

---

## 1. Requirements

- **macOS** with **Node.js 18.17+** (`node -v` to check; install from
  <https://nodejs.org> if needed).
- If `npm install` complains about building `better-sqlite3`, install Xcode
  Command Line Tools once: `xcode-select --install`.

## 2. Setup (one time)

Open Terminal, `cd` into this folder, then:

```bash
npm install                    # install dependencies
npm run setup                  # download the Chromium browser Playwright uses
cp .env.example .env           # create your config file
```

Open `.env` in a text editor and set at least:

```
AI_PROVIDER=anthropic          # or: openai
AI_API_KEY=sk-...              # your key
```

That's the only required config. Everything else has sane defaults.

## 3. Import your existing data (optional but recommended)

Your three Supabase CSVs are already in the `import/` folder. Load them:

```bash
npm run import
```

You'll see `142 jobs imported`, your profile, and the status history. Re-running
is safe — it replaces, it doesn't duplicate. (To import from elsewhere:
`node src/import-supabase.js /path/to/folder-with-csvs`.)

## 4. Run it

```bash
npm start
```

Open **<http://localhost:5179>** in your browser. To stop the server, press
`Ctrl-C` in the Terminal.

---

## Using it

**Dashboard.** Three columns by match tier (1 = strong, 3 = low), the same
layout as before. Click any card to open its detail drawer.

**Scrape now.** Scans every source in Settings → Scrape sources, extracts
postings, scores them against your resume/preferences, and adds new ones.
Progress streams live; a report at the end shows what each source returned.

**In a job's drawer:**

- **Tailor** — rewrites your resume + cover letter for that specific job (no
  fabrication) and stores both, viewable right there.
- **Open apply page** — opens the job's application URL in a new tab so you can
  apply on the company site yourself.
- **Mark applied** — records that you applied; the job moves to the Applied view.
- **Reject** — dismisses it and records feedback so future scoring avoids
  similar roles.

**Settings.** Your resume text, base cover letter, targeting (titles / keywords
/ locations / excluded companies), and scrape sources.

---

## Performance knobs (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `SCRAPE_CONCURRENCY` | 6 | Sources scraped in parallel |
| `PAGE_CONCURRENCY` | 4 | Job pages per source in parallel |
| `PAGE_TIMEOUT_MS` | 15000 | Max wait for a page |
| `SCORE_BATCH_SIZE` | 10 | Jobs scored per AI call |
| `SCORE_CONCURRENCY` | 4 | Scoring batches run in parallel |

If your Mac is older or RAM-limited, lower `SCRAPE_CONCURRENCY` to 3–4.

## Choosing a model

- **Anthropic** (default): leave `AI_MODEL` blank to use `claude-3-5-haiku-latest`
  (fast and cheap). Override with any model string, e.g. a Sonnet model for
  higher-quality tailoring.
- **OpenAI** / compatible: set `AI_PROVIDER=openai`; default model is
  `gpt-4o-mini`. Set `AI_BASE_URL` to point at OpenRouter, Ollama, LM Studio,
  etc.

## Scheduled scraping + email digest (hosted)

Run the scraper on a schedule and get an email of the new high-scoring jobs.
This is fully headless, so it runs on a server.

**How it works:** set `SCRAPE_INTERVAL_HOURS` and the app runs the scrape on
that interval in-process, then emails every newly inserted job scoring at or
above `DIGEST_MIN_SCORE` (default 85) via [Resend](https://resend.com).

Relevant `.env` / env vars:

| Variable | Default | What it does |
|---|---|---|
| `SCRAPE_INTERVAL_HOURS` | 0 (off) | Hours between auto-scrapes. Set to `4`. |
| `DIGEST_MIN_SCORE` | 85 | Only email matches at/above this score |
| `RESEND_API_KEY` | — | Your Resend API key |
| `DIGEST_TO` | — | Where to send the digest |
| `DIGEST_FROM` | `onboarding@resend.dev` | Sender (test default works to your own Resend email) |
| `APP_PASSWORD` | — | If set, the whole app requires this password (Basic Auth) |

Test it locally first: `npm start`, then
`curl -X POST http://localhost:5179/api/scrape/run` runs one scrape+digest now.

> **Resend + an outlook.com (or any external) recipient:** Resend's shared
> `onboarding@resend.dev` sender can only deliver to the email address that owns
> the Resend account. To email `esben.kofoed@outlook.com`, either sign up for
> Resend **with that Outlook address** (then the test sender works as-is), or
> verify your own domain in Resend and set `DIGEST_FROM` to an address on it.
> Verifying a domain is the more reliable long-term option (Outlook is strict
> about spam).

### Deploy to Fly.io

A `Dockerfile` and `fly.toml` are included.

```bash
# 1. Install the CLI and sign in
brew install flyctl       # or: curl -L https://fly.io/install.sh | sh
fly auth signup           # (or: fly auth login)

# 2. From this folder, create the app (don't deploy yet)
fly launch --no-deploy
#   - accept using the existing fly.toml / Dockerfile
#   - it will pick a unique app name (or edit `app` in fly.toml first)

# 3. Create the persistent disk for the SQLite DB (match fly.toml: name "jobdata")
fly volumes create jobdata --size 1 --region <your-region>

# 4. Set your secrets (never commit these). DIGEST_TO is already in fly.toml.
fly secrets set \
  AI_API_KEY=sk-ant-... \
  RESEND_API_KEY=re_... \
  APP_PASSWORD=pick-a-strong-password

# 5. Deploy
fly deploy

# 6. Open it and finish setup (resume text, targets, locations, scrape sources)
fly open
```

On first boot the database is empty, so set your **resume text, target
preferences (titles/keywords/locations), and scrape sources** in the deployed
app's Settings page. (Alternatively, copy your local `data/job-agent.db` onto
the volume with `fly ssh sftp` to bring your existing 142 jobs + profile along —
stop the machine first so the DB isn't locked.)

The interval, min-score, and from-address are already set in `fly.toml`'s
`[env]`; change them there and re-deploy to adjust. Logs: `fly logs` (you'll see
`[scheduler] every 4h …` and each run's insert/email counts).

**Cost:** a `shared-cpu-1x` / 1 GB machine with a 1 GB volume runs ~$5–6/month.
1 GB RAM gives Chromium headroom for browser-fallback scrapes; most of your
sources hit ATS JSON APIs and need no browser at all.

## Troubleshooting

- **"AI key missing" pill** — set `AI_API_KEY` in `.env` and restart.
- **`better-sqlite3` install fails** — run `xcode-select --install`, then
  `npm install` again.
- **Scrape finds nothing** — run `npm run setup` to ensure Chromium is installed.
- **A source returns 0 jobs** — many big employer boards (Workday/Oracle) are
  JavaScript-gated or paginated; a direct ATS link
  (e.g. `boards.greenhouse.io/<company>`) usually works better than the
  marketing `/careers` page.

## Project layout

```
src/
  server.js          Express API + serves the UI
  db.js              SQLite schema + queries
  ai.js              Anthropic/OpenAI calls: extract, batch-score, tailor
  browser.js         Shared Chromium for scraping
  scraper.js         Fast parallel scraper
  scheduler.js       In-process every-N-hours scrape + digest trigger
  notify.js          Resend email digest of high-scoring new jobs
  twofa.js           Optional Outlook 2FA code fetcher
  import-supabase.js CSV importer for your old data
public/              The web UI (index.html, app.js, styles.css)
import/              Your Supabase CSV exports
data/                The local SQLite database (created on first run)
```
