// Fast, local job-board scraper.
//
// Why it's fast (vs. the original Cloudflare-Worker version):
//   • No Worker upstream timeout -> real concurrency (sources AND pages in
//     parallel, configurable via .env).
//   • Smart waits instead of a fixed 2.5s sleep per page.
//   • Assets (images/fonts/css) blocked at the network layer.
//   • Scoring is BATCHED (many jobs per AI call) and deduping is done in
//     memory against one upfront snapshot — no per-job DB round-trips.
import { newScrapeContext, closeBrowser } from "./browser.js";
import { extractJobs, scoreJobsBatch, minYearsRequired, beginUsageCapture, endUsageCapture } from "./ai.js";
import { mapWithConcurrency, buildLocationMatcher, parseSalary } from "./util.js";
import { config } from "./config.js";
import {
  getProfile, existingJobKeys, insertJob, listJobs, updateJob, deleteJob,
  setSourceHealth, getSourceHealth, rejectedJobKeys, addScoreReject, getMeta, setMeta,
} from "./db.js";
import { getAdapter } from "./adapters.js";

const CANDIDATE_RE =
  /\/job[/_-]|\/jobs\/|\/posting|\/openings?\/|\/careers?\/[^/]+\/|requisition|job_id=|jobid=|posting_id|\/vacancy\/|\/positions?\//i;

const NEG_RE = /linkedin\.com|indeed\.com|glassdoor\.|builtin\.|wellfound\.|otta\./i;

const JOBISH_URL = /job|search|career|position|posting|requisition|vacanc|listing|opening/i;

// Open one URL, wait intelligently, return its text + same-host links. Also
// captures job-ish JSON the page fetches over XHR — for SPAs (Microsoft, Adobe,
// Snowflake, …) the rendered text is empty but the real jobs come over the wire,
// so we feed that JSON to the AI extractor too.
async function scrapePage(ctx, url) {
  const page = await ctx.newPage();
  const captured = [];
  let capLen = 0;
  page.on("response", async (resp) => {
    try {
      if (capLen > 80000) return;
      const ct = resp.headers()["content-type"] || "";
      if (!/json/.test(ct)) return;
      if (!JOBISH_URL.test(resp.url())) return;
      const txt = await resp.text();
      if (txt && txt.length > 80 && /"(title|name|jobTitle|posting|position)"/i.test(txt)) {
        const chunk = txt.slice(0, 30000);
        captured.push(chunk);
        capLen += chunk.length;
      }
    } catch { /* body already consumed / binary */ }
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.scrape.pageTimeoutMs });
    // Give client-rendered boards a brief, bounded chance to populate.
    await page
      .waitForLoadState("networkidle", { timeout: 4000 })
      .catch(() => {});
    await page
      .waitForSelector(
        'a[href*="job"], a[href*="position"], [class*="job"], [data-automation-id], li, article',
        { timeout: 2500 }
      )
      .catch(() => {});

    const data = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => a.href)
        .filter((h) => h && h.startsWith("http"));
      return { text, links };
    });
    let text = (data.text || "").replace(/\s+\n/g, "\n").trim();
    if (captured.length) text += "\n\n[CAPTURED JOB DATA (JSON)]\n" + captured.join("\n").slice(0, 80000);
    return { text, links: data.links || [] };
  } catch (e) {
    return { text: "", links: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    await page.close().catch(() => {});
  }
}

function pickCandidates(baseUrl, links, prefs) {
  let host;
  try { host = new URL(baseUrl).host; } catch { host = ""; }
  const wanted = [
    ...(prefs.titles ?? []).slice(0, 4),
    ...(prefs.keywords ?? []).slice(0, 4),
  ].map((s) => String(s).toLowerCase());

  const seen = new Set([baseUrl]);
  const scored = [];
  for (const raw of links) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    const clean = `${u.origin}${u.pathname}`;
    if (seen.has(clean)) continue;
    if (u.host !== host) continue;
    if (NEG_RE.test(clean)) continue;
    if (!CANDIDATE_RE.test(clean)) continue;
    seen.add(clean);
    const lower = (clean + " " + raw).toLowerCase();
    const score = wanted.reduce((s, w) => (lower.includes(w) ? s + 1 : s), 0);
    scored.push({ url: clean, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.url);
}

// Cheap lexical pre-filter. When the user has configured target titles/keywords,
// drop postings whose TITLE shares no significant word with them BEFORE paying
// to AI-score them — this is the big cost saver for full-board ATS adapters
// (Greenhouse/Lever/Ashby) that return every opening. Title-only matching keeps
// it safe: a relevant role worded differently in the body still survives, but an
// obviously off-target title ("Line Cook" when you want "Data Analyst") doesn't
// reach the scorer. No titles/keywords configured -> keep everything.
const PREFILTER_STOP = new Set([
  "the", "and", "for", "with", "you", "your", "our", "job", "jobs", "role",
  "new", "all", "any", "team", "senior", "junior", "lead", "staff",
]);
function buildTitlePrefilter(prefs) {
  const words = new Set();
  for (const s of [...(prefs.titles ?? []), ...(prefs.keywords ?? [])]) {
    for (const w of String(s).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !PREFILTER_STOP.has(w)) words.add(w);
    }
  }
  if (!words.size) return null;
  return (title) => {
    const t = String(title || "").toLowerCase();
    for (const w of words) if (t.includes(w)) return true;
    return false;
  };
}

function sanitize(jobs, fallbackCompany, fallbackUrl, sourceUrl) {
  const out = [];
  for (const j of jobs) {
    const title = String(j.job_title ?? "").trim();
    const desc = String(j.job_description_raw ?? "").trim();
    if (title.length < 2 || desc.length < 20) continue;
    const periodRaw = String(j.salary_period ?? "").toLowerCase();
    const period = ["year", "month", "week", "day", "hour"].includes(periodRaw) ? periodRaw : null;
    const rawUrl = String(j.job_url ?? "").trim();
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : fallbackUrl || sourceUrl || null;

    let posted_at = null;
    if (j.posted_date_iso) {
      const d = new Date(j.posted_date_iso);
      if (!isNaN(d.getTime())) posted_at = d.toISOString();
    }
    if (!posted_at && typeof j.posted_days_ago === "number" && j.posted_days_ago >= 0) {
      posted_at = new Date(Date.now() - j.posted_days_ago * 86400000).toISOString();
    }

    out.push({
      job_title: title,
      company_name: String(j.company_name ?? "").trim() || fallbackCompany,
      location: String(j.location ?? "").trim(),
      job_description_raw: desc,
      salary_min: typeof j.salary_min === "number" ? j.salary_min : null,
      salary_max: typeof j.salary_max === "number" ? j.salary_max : null,
      salary_currency: j.salary_currency ?? null,
      salary_period: period,
      salary_raw: j.salary_raw ?? null,
      posted_at,
      posted_at_raw: j.posted_at_raw ?? null,
      job_url: url,
    });
  }
  return out;
}

function companyFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    const parts = u.pathname.split("/").filter(Boolean);
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com/.test(host)) {
      if (parts[0]) return parts[0].replace(/[-_]+/g, " ");
    }
    return host.split(".").slice(-2, -1)[0] ?? host;
  } catch {
    return "Unknown";
  }
}

// ---------------------------------------------------------------------------
// Main entry. `onEvent` receives {type, ...} progress messages for SSE.
// ---------------------------------------------------------------------------
// Backstop so a wedged run can't hold the lock forever. Raised 18→30 min:
// the once-daily browser-path slot (07:00) legitimately runs ~18.5 min and was
// tripping the old 18-min limit right at the finish — the work completed and
// jobs were inserted, but the caller had already thrown, so last_scrape_auto
// never updated and the digest step was skipped. 30 min gives real headroom
// while still guaranteeing the lock releases well before the next slot.
const SCRAPE_MAX_MS = 30 * 60 * 1000;

let scrapeInFlight = false;
export function isScraping() {
  return scrapeInFlight;
}

export async function runScrape(opts = {}) {
  // Serialize runs: the scheduled scrape and a manual one must never overlap
  // (shared browser + no DB unique constraint => possible double inserts).
  if (scrapeInFlight) throw new Error("A scrape is already running. Try again when it finishes.");
  scrapeInFlight = true;
  // Backstop timeout so the lock can NEVER stay stuck if something hangs below
  // the per-request timeouts (this once froze the scheduler for days).
  let watchdog;
  const timeout = new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(new Error(`Scrape exceeded ${SCRAPE_MAX_MS / 60000} min — aborted.`)), SCRAPE_MAX_MS);
  });
  try {
    return await Promise.race([runScrapeInner(opts), timeout]);
  } catch (e) {
    // A watchdog abort only abandons the promise — the underlying scrape and
    // its Chromium keep running in the background. Force-kill the shared
    // browser so a wedged run can't hold memory and hang every later slot
    // (observed 2026-07-06: one stuck 07:00 run left 8 zombie Chromium
    // processes and poisoned the whole day's schedule).
    closeBrowser().catch(() => {});
    throw e;
  } finally {
    clearTimeout(watchdog);
    scrapeInFlight = false;
  }
}

async function runScrapeInner({ urls, onEvent = () => {}, scheduled = false } = {}) {
  const profile = getProfile();
  const prefs = profile.target_preferences ?? {};
  let sources = (urls && urls.length
    ? urls.map((u) => ({ url: u, label: "" }))
    : prefs.scrape_sources ?? []
  ).filter((s) => s && s.url);

  if (sources.length === 0) {
    throw new Error("No scrape sources. Add some in Settings (or pass URLs).");
  }

  // Browser-path sources cost AI extraction on every run while yielding the
  // fewest jobs, and boards don't churn hourly — on SCHEDULED runs they
  // participate only in the first slot of the day. Manual scrapes always run
  // everything. Also gates the adapter→browser fallback below.
  let browserAllowed = true;
  if (scheduled) {
    const today = new Date().toDateString(); // box TZ is America/New_York
    if (getMeta("browser_last_run_day") === today) browserAllowed = false;
    else setMeta("browser_last_run_day", today);
  }
  if (!browserAllowed) sources = sources.filter((s) => !!getAdapter(s.url));

  beginUsageCapture();

  const excluded = new Set((prefs.excluded_companies ?? []).map((s) => String(s).toLowerCase().trim()));
  // Wrap the location matcher to sample what it drops (distinct, capped) — the
  // filter discards hundreds of jobs per run, and without a sample of the actual
  // strings a synonym gap (e.g. bare "NY") is invisible. Run-level, not
  // per-source: the point is spotting false-drop patterns, not attribution.
  const baseLocMatch = buildLocationMatcher(prefs.location_filter);
  const droppedLocSamples = new Set();
  const locMatch = baseLocMatch
    ? (loc) => {
        const ok = baseLocMatch(loc);
        if (!ok && loc && droppedLocSamples.size < 40) droppedLocSamples.add(String(loc).slice(0, 80));
        return ok;
      }
    : null;
  const excludeTitles = (prefs.exclude_title_keywords ?? [])
    .map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  const minScore = Math.max(0, Math.min(100, Number(prefs.min_score) || 0));
  const titleMatch = buildTitlePrefilter(prefs);
  const existing = existingJobKeys();
  const rejects = rejectedJobKeys(minScore); // known low-scorers: skip before AI
  const seenThisRun = new Set();
  const jobKey = (t, c) => `${String(t || "").toLowerCase()}|${String(c || "").toLowerCase().trim()}`;

  onEvent({ type: "start", total: sources.length });

  const ctx = await newScrapeContext();
  const reports = [];
  let done = 0;

  // Phase 1: scrape + extract + dedupe per source (highly parallel).
  const perSource = await mapWithConcurrency(sources, config.scrape.sourceConcurrency, async (src) => {
    const report = {
      url: src.url,
      label: src.label || "",
      scraped: false,
      pages_checked: 0,
      extracted: 0,
      inserted: 0,
      skipped_duplicates: 0,
      skipped_excluded: 0,
      skipped_location: 0,
      skipped_title: 0,
      skipped_irrelevant: 0,
      skipped_low_score: 0,
      skipped_known_reject: 0,
      skipped_seniority_gate: 0,
      error: undefined,
      // Diagnostics for the JSON export — explains *why* a source yielded
      // nothing (gated page, no candidate links, all off-location, etc.).
      diagnostics: {
        base_text_length: 0,
        base_text_sample: "",
        links_found: 0,
        candidate_urls: [],
        extract_errors: 0,
        extracted: [], // {title, company, location, decision}
      },
    };
    const newJobs = [];
    // Shared sink: dedupe + geo/exclude filter + diagnostics for one clean job.
    const ingest = (c) => {
      if (!c || !c.job_title || !c.job_title.trim()) return;
      report.extracted++;
      const company = (c.company_name || "").toLowerCase().trim();
      const title = c.job_title.toLowerCase();
      let decision = "kept";
      if (excluded.has(company)) { report.skipped_excluded++; decision = "excluded"; }
      else if (excludeTitles.some((k) => title.includes(k))) { report.skipped_title++; decision = "title_excluded"; }
      else if (locMatch && !locMatch(c.location)) { report.skipped_location++; decision = "off_location"; }
      else {
        const key = jobKey(c.job_title, c.company_name);
        if (existing.has(key) || seenThisRun.has(key)) { report.skipped_duplicates++; decision = "duplicate"; }
        else if (rejects.has(key)) { report.skipped_known_reject++; decision = "known_reject"; }
        else { seenThisRun.add(key); newJobs.push(c); }
      }
      if (report.diagnostics.extracted.length < 50) {
        report.diagnostics.extracted.push({ title: c.job_title, company: c.company_name, location: c.location, decision });
      }
    };

    try {
      const adapter = getAdapter(src.url);
      let runBrowser = !adapter;
      if (adapter) {
        // ---- Fast path: query the ATS JSON API directly (no browser) ----
        report.diagnostics.via = `api:${adapter.name}`;
        const out = await adapter.fetch(src.url, { prefs, companyHint: src.label, locMatch });
        const jobs = out.jobs || [];
        report.scraped = jobs.length > 0;
        report.pages_checked = out.pages || 1;
        report.skipped_location += out.dropped_location || 0; // dropped early, before scoring
        report.diagnostics.api_jobs = jobs.length;
        if (out.note) report.diagnostics.note = out.note;
        if (out.error) report.error = `${adapter.name} API: ${out.error}`;
        else if (jobs.length === 0) report.error = `${adapter.name} API returned no matching jobs.`;
        for (const c of jobs) ingest(c);
        // Fall back to the browser when the API errored and yielded nothing — e.g.
        // an auth-locked Eightfold tenant whose page still renders and XHRs its jobs
        // (the network-capture in scrapePage then grabs them).
        if (out.error && newJobs.length === 0 && browserAllowed) { runBrowser = true; report.error = undefined; report.diagnostics.via = `api:${adapter.name}→browser`; }
        else if (out.error && newJobs.length === 0 && !browserAllowed) { report.diagnostics.note = "Browser fallback deferred (browser paths run once daily on scheduled scrapes)."; }
      }
      if (runBrowser) {
        // ---- Browser path: load the HTML page(s) and AI-extract ----
        if (!String(report.diagnostics.via || "").includes("browser")) report.diagnostics.via = "browser";
        const base = await scrapePage(ctx, src.url);
        report.diagnostics.base_text_length = base.text.length;
        report.diagnostics.base_text_sample = base.text.slice(0, 600);
        report.diagnostics.links_found = (base.links || []).length;
        if (base.error) report.diagnostics.load_error = base.error;
        const pages = [];
        if (base.text.length >= 120) {
          report.scraped = true;
          pages.push({ url: src.url, text: base.text });
        }
        const candidates = pickCandidates(src.url, base.links, prefs);
        report.diagnostics.candidate_urls = candidates;
        const candPages = await mapWithConcurrency(candidates, config.scrape.pageConcurrency, async (u) => {
          const r = await scrapePage(ctx, u);
          return r.text.length >= 120 ? { url: u, text: r.text } : null;
        });
        for (const p of candPages) if (p) pages.push(p);
        report.pages_checked = pages.length;
        if (pages.length === 0) {
          report.error = "Page loaded but no readable content (likely login-gated or fully JS-rendered).";
        }
        const fallbackCompany = companyFromUrl(src.url);
        const extractions = await mapWithConcurrency(pages, 3, async (p) => {
          const r = await extractJobs(p.text, p.url);
          if (r.error) report.diagnostics.extract_errors++;
          return sanitize(r.jobs ?? [], fallbackCompany, null, p.url);
        });
        for (const cleaned of extractions) {
          if (!Array.isArray(cleaned)) continue;
          for (const c of cleaned) ingest(c);
        }
      }
    } catch (e) {
      report.error = e instanceof Error ? e.message : String(e);
    } finally {
      done++;
      onEvent({ type: "progress", done, total: sources.length, report });
      reports.push(report);
    }
    return { report, newJobs };
  });

  await ctx.close().catch(() => {});

  // Phase 2: batch-score every new job at once, then insert.
  const flat = [];
  for (const ps of perSource) {
    if (!ps || ps.__error) continue;
    for (const j of ps.newJobs) {
      if (titleMatch && !titleMatch(j.job_title)) { ps.report.skipped_irrelevant++; continue; }
      // Deterministic seniority gate: the rubric hard-caps at 55 (below
      // min_score) when the stated minimum exceeds the candidate by ~3 years —
      // that check is mechanical, so no AI call needed. Persisted as a reject
      // so the job short-circuits at dedupe on future scrapes.
      if (minScore && minYearsRequired(j.job_description_raw) >= 8) {
        ps.report.skipped_seniority_gate++;
        try { addScoreReject(jobKey(j.job_title, j.company_name), 55); } catch { /* best-effort */ }
        continue;
      }
      flat.push({ job: j, report: ps.report });
    }
  }

  const insertedJobs = [];
  if (flat.length) {
    onEvent({ type: "scoring", count: flat.length });
    const scores = await scoreJobsBatch(flat.map((f) => f.job), profile);
    for (let i = 0; i < flat.length; i++) {
      const { job, report } = flat[i];
      const s = scores[i] ?? { match_percentage: 50, match_reasoning: "", tier: "TIER_3" };
      // Drop low scorers entirely so they never reach the board — and remember
      // them so they are never scored again (the boards return the same
      // postings every scrape; re-scoring known rejects was the biggest AI cost).
      // NEVER persist inconclusive fallbacks (score 50 when the AI call failed):
      // that would permanently blacklist jobs that were never actually judged.
      if (minScore && s.match_percentage < minScore) {
        report.skipped_low_score++;
        if (!s.inconclusive) {
          try { addScoreReject(jobKey(job.job_title, job.company_name), s.match_percentage); } catch { /* best-effort */ }
        }
        continue;
      }
      const status = s.tier === "TIER_3" ? "SCRAPED" : "PENDING_APPROVAL";
      // Fallback salary capture: if the adapter/AI didn't supply a range, parse
      // one from the description text (deterministic, free). Never overrides an
      // explicit value.
      const sal = job.salary_min == null && job.salary_max == null ? parseSalary(job.job_description_raw) : null;
      const id = insertJob({
        ...job,
        ...(sal ? { salary_min: sal.min, salary_max: sal.max, salary_currency: job.salary_currency || "USD", salary_period: job.salary_period || "year" } : {}),
        match_percentage: s.match_percentage,
        match_reasoning: s.match_reasoning,
        tier: s.tier,
        status,
      });
      report.inserted++;
      insertedJobs.push({
        id,
        job_title: job.job_title,
        company_name: job.company_name,
        location: job.location,
        job_url: job.job_url,
        match_percentage: s.match_percentage,
        match_reasoning: s.match_reasoning,
        tier: s.tier,
      });
    }
  }

  const totalInserted = reports.reduce((a, r) => a + r.inserted, 0);

  // Persist per-source health so the dashboard can show a working/empty/error
  // dot next to each source. "ok" = the source returned jobs (regardless of how
  // many the NY filter later dropped); "empty" = loaded but found nothing.
  try {
    // Merge onto the existing map: sources skipped this run (e.g. browser
    // paths on later scheduled slots) keep their last-known dot.
    const health = getSourceHealth();
    for (const r of reports) {
      if (!r || !r.url) continue;
      // "Working" = the source produced any jobs at all, even if the NY filter
      // later dropped every one. Count location-dropped jobs so a board with
      // 166 non-NY roles reads as ok, not empty. (An ATS that returns jobs but
      // 0 NY still sets r.error to "no matching jobs" — that's not a failure.)
      const kept = Math.max(r.diagnostics?.api_jobs || 0, r.extracted || 0);
      const yielded = kept + (r.skipped_location || 0) + (r.inserted || 0);
      const status = yielded > 0 ? "ok" : r.error ? "error" : "empty";
      health[r.url] = {
        status,
        jobs: yielded,
        inserted: r.inserted || 0,
        via: r.diagnostics?.via || null,
        error: r.error || null,
        at: new Date().toISOString(),
      };
    }
    setSourceHealth(health);
  } catch { /* health is best-effort; never fail a scrape over it */ }

  const dropped_location_samples = [...droppedLocSamples];
  const ai_usage = endUsageCapture();
  if (ai_usage) {
    console.log(
      `[scrape] AI usage: ${ai_usage.calls} calls, in=${ai_usage.input} out=${ai_usage.output} ` +
      `cache_read=${ai_usage.cache_read} cache_write=${ai_usage.cache_write} — est $${ai_usage.cost}`
    );
  }
  onEvent({ type: "done", total_inserted: totalInserted, reports, dropped_location_samples, ai_usage });
  return { ok: true, total_inserted: totalInserted, reports, inserted: insertedJobs, dropped_location_samples, ai_usage };
}

// ---------------------------------------------------------------------------
// Re-score every job already on the board with the current scoring prompt.
// Used to apply prompt/calibration changes to existing jobs (a normal scrape
// skips them via dedup). Jobs that fall below min_score are removed to match
// the scrape gate — except ones the user has acted on (applied/tailored).
// ---------------------------------------------------------------------------
export async function rescoreBoard() {
  const profile = getProfile();
  const jobs = listJobs().filter((j) => j.status !== "REJECTED");
  if (!jobs.length) return { updated: 0, total: 0 };

  // Non-destructive: only update scores/tiers. (Re-scoring has run-to-run
  // variance, so deleting below-threshold jobs would compound losses across
  // passes. Low scorers just fall to Tier 3 — hide them with the dashboard
  // min-score filter, or clear them manually.)
  const scores = await scoreJobsBatch(jobs, profile);
  let updated = 0;
  for (let i = 0; i < jobs.length; i++) {
    const s = scores[i];
    if (!s) continue;
    updateJob(jobs[i].id, {
      match_percentage: s.match_percentage,
      match_reasoning: s.match_reasoning,
      tier: s.tier,
    });
    updated++;
  }
  return { updated, total: jobs.length };
}
