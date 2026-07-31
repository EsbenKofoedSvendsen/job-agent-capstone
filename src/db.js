import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });

const db = new Database(config.paths.db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema (mirrors the original Supabase model, minus auth/RLS which a local
// single-user app doesn't need). JSON-ish columns are stored as TEXT.
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  id                       TEXT PRIMARY KEY,
  base_resume_text         TEXT NOT NULL DEFAULT '',
  base_cover_letter_text   TEXT NOT NULL DEFAULT '',
  target_preferences       TEXT NOT NULL DEFAULT '{"titles":[],"locations":[],"keywords":[],"scrape_sources":[],"excluded_companies":[]}',
  negative_feedback_corpus TEXT NOT NULL DEFAULT '[]',
  application_profile      TEXT NOT NULL DEFAULT '{}',
  resume_pdf_path          TEXT,
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id                        TEXT PRIMARY KEY,
  job_title                 TEXT NOT NULL,
  company_name              TEXT NOT NULL,
  location                  TEXT,
  job_description_raw       TEXT NOT NULL DEFAULT '',
  match_percentage          INTEGER NOT NULL DEFAULT 0,
  match_reasoning           TEXT NOT NULL DEFAULT '',
  tier                      TEXT NOT NULL DEFAULT 'TIER_3',
  status                    TEXT NOT NULL DEFAULT 'SCRAPED',
  tailored_resume_text      TEXT,
  tailored_cover_letter_text TEXT,
  scraped_at                TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at                TEXT,
  salary_min                REAL,
  salary_max                REAL,
  salary_currency           TEXT,
  salary_period             TEXT,
  salary_raw                TEXT,
  posted_at                 TEXT,
  posted_at_raw             TEXT,
  job_url                   TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_tier_idx   ON jobs(tier);
CREATE INDEX IF NOT EXISTS jobs_dedupe_idx ON jobs(job_title, company_name);

CREATE TABLE IF NOT EXISTS job_status_log (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS jsl_job_idx ON job_status_log(job_id);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS error_log (
  id      TEXT PRIMARY KEY,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  context TEXT,
  job_id  TEXT,
  message TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS error_log_at_idx ON error_log(at);

CREATE TABLE IF NOT EXISTS rescore_log (
  id              TEXT PRIMARY KEY,
  at              TEXT NOT NULL DEFAULT (datetime('now')),
  job_title       TEXT,
  company_name    TEXT,
  first_score     INTEGER,
  final_score     INTEGER,
  delta           INTEGER,
  first_reasoning TEXT,
  final_reasoning TEXT
);
CREATE INDEX IF NOT EXISTS rescore_log_at_idx ON rescore_log(at);
`);

// Migrations for rescore_log reasoning columns (ALTER throws if already present).
try { db.exec("ALTER TABLE rescore_log ADD COLUMN first_reasoning TEXT"); } catch { /* already there */ }
try { db.exec("ALTER TABLE rescore_log ADD COLUMN final_reasoning TEXT"); } catch { /* already there */ }

// Migration: per-job "this was emailed in a digest" marker. Wrapped because
// ALTER TABLE ADD COLUMN throws if the column already exists.
try { db.exec("ALTER TABLE jobs ADD COLUMN notified_at TEXT"); } catch { /* already there */ }

const PROFILE_ID = "local";
const uuid = () => crypto.randomUUID();

const JSON_COLS = {
  target_preferences: true,
  negative_feedback_corpus: true,
  application_profile: true,
};

function parseProfile(row) {
  if (!row) return null;
  const out = { ...row };
  for (const k of Object.keys(JSON_COLS)) {
    try {
      out[k] = JSON.parse(row[k]);
    } catch {
      out[k] = k === "negative_feedback_corpus" ? [] : {};
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Profile (single row for this local user)
// ---------------------------------------------------------------------------
export function getProfile() {
  let row = db.prepare("SELECT * FROM profiles LIMIT 1").get();
  if (!row) {
    db.prepare("INSERT INTO profiles (id) VALUES (?)").run(PROFILE_ID);
    row = db.prepare("SELECT * FROM profiles LIMIT 1").get();
  }
  return parseProfile(row);
}

export function updateProfile(patch) {
  const current = getProfile();
  const next = { ...current, ...patch };
  db.prepare(
    `UPDATE profiles SET
       base_resume_text = ?,
       base_cover_letter_text = ?,
       target_preferences = ?,
       negative_feedback_corpus = ?,
       application_profile = ?,
       resume_pdf_path = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    next.base_resume_text ?? "",
    next.base_cover_letter_text ?? "",
    JSON.stringify(next.target_preferences ?? {}),
    JSON.stringify(next.negative_feedback_corpus ?? []),
    JSON.stringify(next.application_profile ?? {}),
    next.resume_pdf_path ?? null,
    current.id
  );
  return getProfile();
}

// Upsert a profile coming from a Supabase import (keeps its original id/text).
export function importProfile(p) {
  db.prepare("DELETE FROM profiles").run();
  db.prepare(
    `INSERT INTO profiles
       (id, base_resume_text, base_cover_letter_text, target_preferences,
        negative_feedback_corpus, application_profile, resume_pdf_path, updated_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'))`
  ).run(
    p.id || PROFILE_ID,
    p.base_resume_text ?? "",
    p.base_cover_letter_text ?? "",
    JSON.stringify(p.target_preferences ?? {}),
    JSON.stringify(p.negative_feedback_corpus ?? []),
    JSON.stringify(p.application_profile ?? {}),
    p.resume_pdf_path ?? null
  );
  return getProfile();
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export function listJobs() {
  return db
    .prepare(
      `SELECT * FROM jobs
       ORDER BY (posted_at IS NULL), posted_at DESC, scraped_at DESC
       LIMIT 1000`
    )
    .all();
}

export function getJob(id) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!job) return null;
  const log = db
    .prepare("SELECT * FROM job_status_log WHERE job_id = ? ORDER BY created_at DESC")
    .all(id);
  const rescore = getRescoreForJob(job.job_title, job.company_name);
  return { job, log, rescore };
}

// The most recent cascade re-score for a job (matched by title+company, the same
// dedupe key jobs use). Only jobs that cleared the confirm-pass threshold have one;
// returns null otherwise so the drawer can conditionally show the before→after.
export function getRescoreForJob(title, company) {
  if (!title || !company) return null;
  return db.prepare(
    "SELECT first_score, final_score, delta, first_reasoning, final_reasoning, at FROM rescore_log WHERE job_title = ? AND company_name = ? ORDER BY at DESC LIMIT 1"
  ).get(title, company) || null;
}

// Set of "title|company" (lowercased) for O(1) in-memory dedupe during scrape.
export function existingJobKeys() {
  const rows = db.prepare("SELECT job_title, company_name FROM jobs").all();
  const set = new Set();
  for (const r of rows) {
    set.add(`${r.job_title.toLowerCase()}|${r.company_name.toLowerCase()}`);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Negative dedup: jobs that scored below min_score are dropped from the board,
// which used to mean they re-entered scoring on every scrape (the boards return
// the same postings each run) — that repeat scoring was the app's single
// biggest AI cost. Remember their keys so each reject is scored once. Entries
// expire after 30 days so genuinely reposted roles get a fresh look, and keys
// only count as rejects while their score is still below the current min_score
// (lowering the threshold in Settings automatically re-admits them).
// ---------------------------------------------------------------------------
db.exec(`CREATE TABLE IF NOT EXISTS score_rejects (
  key   TEXT PRIMARY KEY,
  score INTEGER,
  at    TEXT NOT NULL DEFAULT (datetime('now'))
)`);

export function rejectedJobKeys(minScore) {
  db.prepare("DELETE FROM score_rejects WHERE at < datetime('now','-30 days')").run();
  const rows = db.prepare("SELECT key, score FROM score_rejects").all();
  const set = new Set();
  for (const r of rows) if (!minScore || r.score < minScore) set.add(r.key);
  return set;
}

export function addScoreReject(key, score) {
  db.prepare(
    "INSERT INTO score_rejects (key, score) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET score = excluded.score, at = datetime('now')"
  ).run(key, score);
}

const INSERT_JOB = db.prepare(`
  INSERT INTO jobs (
    id, job_title, company_name, location, job_description_raw,
    match_percentage, match_reasoning, tier, status,
    salary_min, salary_max, salary_currency, salary_period, salary_raw,
    posted_at, posted_at_raw, job_url, scraped_at, applied_at
  ) VALUES (
    @id, @job_title, @company_name, @location, @job_description_raw,
    @match_percentage, @match_reasoning, @tier, @status,
    @salary_min, @salary_max, @salary_currency, @salary_period, @salary_raw,
    @posted_at, @posted_at_raw, @job_url, @scraped_at, @applied_at
  )
`);

export function insertJob(j) {
  const id = j.id || uuid();
  const row = {
    id,
    job_title: j.job_title,
    company_name: j.company_name,
    location: j.location ?? "",
    job_description_raw: j.job_description_raw ?? "",
    match_percentage: j.match_percentage ?? 0,
    match_reasoning: j.match_reasoning ?? "",
    tier: j.tier ?? "TIER_3",
    status: j.status ?? "SCRAPED",
    salary_min: j.salary_min ?? null,
    salary_max: j.salary_max ?? null,
    salary_currency: j.salary_currency ?? null,
    salary_period: j.salary_period ?? null,
    salary_raw: j.salary_raw ?? null,
    posted_at: j.posted_at ?? null,
    posted_at_raw: j.posted_at_raw ?? null,
    job_url: j.job_url ?? null,
    scraped_at: j.scraped_at ?? new Date().toISOString(),
    applied_at: j.applied_at ?? null,
  };
  INSERT_JOB.run(row);
  addStatusLog(id, null, row.status, "Job scraped and evaluated");
  return id;
}

export function updateJob(id, patch) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  if (!job) return null;
  const next = { ...job, ...patch };
  db.prepare(
    `UPDATE jobs SET
       job_title=?, company_name=?, location=?, job_description_raw=?,
       match_percentage=?, match_reasoning=?, tier=?, status=?,
       tailored_resume_text=?, tailored_cover_letter_text=?,
       salary_min=?, salary_max=?, salary_currency=?, salary_period=?, salary_raw=?,
       posted_at=?, posted_at_raw=?, job_url=?, applied_at=?
     WHERE id=?`
  ).run(
    next.job_title, next.company_name, next.location, next.job_description_raw,
    next.match_percentage, next.match_reasoning, next.tier, next.status,
    next.tailored_resume_text ?? null, next.tailored_cover_letter_text ?? null,
    next.salary_min ?? null, next.salary_max ?? null, next.salary_currency ?? null,
    next.salary_period ?? null, next.salary_raw ?? null,
    next.posted_at ?? null, next.posted_at_raw ?? null, next.job_url ?? null,
    next.applied_at ?? null, id
  );
  if (patch.status && patch.status !== job.status) {
    addStatusLog(id, job.status, patch.status, patch.statusNote ?? null);
  }
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
}

export function deleteJob(id) {
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
}

// Wipe every job (and its status history) but keep the profile/settings.
export function clearJobs() {
  db.prepare("DELETE FROM job_status_log").run();
  const n = db.prepare("SELECT COUNT(*) c FROM jobs").get().c;
  db.prepare("DELETE FROM jobs").run();
  return n;
}

// Remove only the jobs the user has already applied to (status APPLIED).
// FK ON DELETE CASCADE clears their status-log rows automatically.
export function deleteApplied() {
  const n = db.prepare("SELECT COUNT(*) c FROM jobs WHERE status = 'APPLIED'").get().c;
  db.prepare("DELETE FROM jobs WHERE status = 'APPLIED'").run();
  return n;
}

// Salary distribution across the board, bucketed by résumé-match level, for a
// market-value estimate. Reads the stored salary columns only (populate them via
// the scraper's parseSalary fallback + the backfill script). "band" = median of
// the low ends and median of the high ends; the p25/median/p75 describe role
// midpoints.
export function getSalaryInsights() {
  const rows = db
    .prepare(
      "SELECT match_percentage, salary_min, salary_max FROM jobs " +
        "WHERE status != 'REJECTED' AND salary_min IS NOT NULL AND salary_max IS NOT NULL AND salary_max >= salary_min"
    )
    .all();
  const total = db.prepare("SELECT COUNT(*) c FROM jobs WHERE status != 'REJECTED'").get().c;
  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.floor((s.length - 1) * p)]);
  };
  const bucket = (label, minMatch) => {
    const g = rows.filter((r) => (r.match_percentage || 0) >= minMatch);
    const mids = g.map((r) => (r.salary_min + r.salary_max) / 2);
    return {
      label,
      min_match: minMatch,
      n: g.length,
      median: pct(mids, 0.5),
      p25: pct(mids, 0.25),
      p75: pct(mids, 0.75),
      band_low: pct(g.map((r) => r.salary_min), 0.5),
      band_high: pct(g.map((r) => r.salary_max), 0.5),
    };
  };
  return {
    coverage: { with_salary: rows.length, total },
    buckets: [
      bucket("Strong match (85+)", 85),
      bucket("Good match (70+)", 70),
      bucket("Worth a look (65+)", 65),
    ],
  };
}

// ---------------------------------------------------------------------------
// App metadata (simple key/value: last-scrape timestamps, etc.)
// ---------------------------------------------------------------------------
export function setMeta(key, value) {
  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
export function getMeta(key) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

// ---------------------------------------------------------------------------
// Per-source health: the latest scrape outcome for each configured source,
// keyed by source URL. Lets the dashboard show a working/empty/error dot next
// to each source without re-running a scrape. Stored as one JSON blob in
// app_meta (no schema migration).
// ---------------------------------------------------------------------------
export function setSourceHealth(map) {
  setMeta("source_health", JSON.stringify(map || {}));
}
export function getSourceHealth() {
  try { return JSON.parse(getMeta("source_health") || "{}"); } catch { return {}; }
}

// Log of every Sonnet confirm-pass: what the cheap first pass scored vs. what the
// stronger model changed it to. Drives the "rescore impact" chart.
export function logRescore(rows) {
  if (!rows || !rows.length) return;
  const stmt = db.prepare(
    "INSERT INTO rescore_log (id, at, job_title, company_name, first_score, final_score, delta, first_reasoning, final_reasoning) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  const now = new Date().toISOString();
  const tx = db.transaction((list) => {
    for (const r of list) stmt.run(uuid(), now, String(r.job_title || "").slice(0, 200), String(r.company_name || "").slice(0, 120), r.first, r.final, r.final - r.first, String(r.first_reasoning || "").slice(0, 800), String(r.final_reasoning || "").slice(0, 800));
  });
  try { tx(rows); db.prepare("DELETE FROM rescore_log WHERE id NOT IN (SELECT id FROM rescore_log ORDER BY at DESC LIMIT 2000)").run(); } catch { /* never throw */ }
}
export function getRescoreStats() {
  const rows = db.prepare("SELECT job_title, company_name, first_score, final_score, delta, first_reasoning, final_reasoning FROM rescore_log ORDER BY at DESC LIMIT 2000").all();
  const total = rows.length;
  const raised = rows.filter((r) => r.delta > 0);
  const lowered = rows.filter((r) => r.delta < 0);
  const unchanged = total - raised.length - lowered.length;
  const avg = (a) => (a.length ? Math.round((a.reduce((s, r) => s + r.delta, 0) / a.length) * 10) / 10 : 0);
  // Histogram buckets of the delta.
  const edges = [[-Infinity, -20], [-20, -10], [-10, -1], [-1, 1], [1, 10], [10, 20], [20, Infinity]];
  const labels = ["≤-20", "-20…-10", "-10…-1", "0", "+1…+10", "+10…+20", "≥+20"];
  const buckets = edges.map(([lo, hi], i) => ({
    label: labels[i],
    count: rows.filter((r) => (i === 3 ? r.delta === 0 : r.delta >= lo && r.delta < hi)).length,
  }));
  const biggest = [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
  return {
    total, raised: raised.length, lowered: lowered.length, unchanged,
    avgDelta: avg(rows), avgUp: avg(raised), avgDown: avg(lowered),
    buckets, biggest, entries: rows.slice(0, 800),
  };
}

// Live-editable scheduling + email settings (overrides the .env seeds once the
// user changes them in the UI). The scraper runs at fixed local times on days
// not in skipDays. times are "HH:MM" 24h; skipDays uses getDay(): 0=Sun … 6=Sat.
const SCHEDULE_DEFAULTS = {
  times: ["07:00", "12:00", "15:00", "18:00"],
  digestMinScore: config.digest.minScore || 85,
  skipDays: [0, 6], // pause the whole weekend by default
  rescoreThreshold: config.ai.rescoreThreshold ?? 75, // Sonnet confirm-pass cutoff
};
function sanitizeTimes(arr) {
  const valid = (Array.isArray(arr) ? arr : [])
    .map((t) => String(t).trim())
    .filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t))
    .map((t) => t.padStart(5, "0"));
  return [...new Set(valid)].sort();
}
export function getScheduleSettings() {
  let s = {};
  try { const raw = getMeta("schedule_settings"); s = raw ? JSON.parse(raw) : {}; } catch { s = {}; }
  const merged = { ...SCHEDULE_DEFAULTS, ...s };
  merged.times = sanitizeTimes(merged.times);
  if (!merged.times.length) merged.times = SCHEDULE_DEFAULTS.times;
  delete merged.intervalHours; // legacy field, no longer used
  return merged;
}
export function setScheduleSettings(patch) {
  const next = { ...getScheduleSettings(), ...patch };
  next.times = sanitizeTimes(next.times);
  if (!next.times.length) next.times = SCHEDULE_DEFAULTS.times;
  next.digestMinScore = Math.max(0, Math.min(100, Math.round(Number(next.digestMinScore) || 0)));
  next.rescoreThreshold = Math.max(0, Math.min(100, Math.round(Number(next.rescoreThreshold) || SCHEDULE_DEFAULTS.rescoreThreshold)));
  next.skipDays = Array.isArray(next.skipDays)
    ? [...new Set(next.skipDays.map(Number).filter((d) => d >= 0 && d <= 6))]
    : [];
  delete next.intervalHours;
  setMeta("schedule_settings", JSON.stringify(next));
  return next;
}

// Live-editable scoring guidance (the rubric + one-shot calibration examples).
// Stored as raw override strings; empty string means "use the built-in default"
// (the defaults live in ai.js so it never has to import them back). Only the
// admin settings UI writes these.
export function getScoringSettings() {
  let s = {};
  try { const raw = getMeta("scoring_settings"); s = raw ? JSON.parse(raw) : {}; } catch { s = {}; }
  return {
    rubric: typeof s.rubric === "string" ? s.rubric : "",
    calibration: typeof s.calibration === "string" ? s.calibration : "",
  };
}
export function setScoringSettings(patch) {
  const cur = getScoringSettings();
  const next = {
    rubric: typeof patch.rubric === "string" ? patch.rubric : cur.rubric,
    calibration: typeof patch.calibration === "string" ? patch.calibration : cur.calibration,
  };
  setMeta("scoring_settings", JSON.stringify(next));
  return next;
}

// Biweekly auto-calibration: a PENDING proposal (new calibration + eval report)
// that the admin reviews and adopts/dismisses. Only one is held at a time.
export function getCalibrationProposal() {
  try { const raw = getMeta("calibration_proposal"); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function setCalibrationProposal(obj) { setMeta("calibration_proposal", JSON.stringify(obj || {})); return obj; }
export function clearCalibrationProposal() { setMeta("calibration_proposal", ""); }

// Sonnet-vs-Opus rescore benchmark (populated by the one-shot bench box script:
// each >70 board job's prior Sonnet-era score/reasoning vs the new Opus score/
// reasoning). Returns [] until the benchmark table exists. Ordered by |delta|.
export function getRescoreBenchmark() {
  try {
    const rows = db.prepare(
      `SELECT job_id, job_title, company_name, sonnet_score, sonnet_tier, sonnet_reasoning,
              opus_score, opus_tier, opus_reasoning, delta, at
       FROM rescore_benchmark WHERE opus_score IS NOT NULL ORDER BY abs(delta) DESC`
    ).all();
    const d = rows.map((r) => r.delta);
    const summary = {
      total: rows.length,
      raised: d.filter((x) => x > 0).length,
      lowered: d.filter((x) => x < 0).length,
      unchanged: d.filter((x) => x === 0).length,
      avgDelta: d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1) : 0,
      tierChanged: rows.filter((r) => r.sonnet_tier !== r.opus_tier).length,
    };
    return { summary, rows };
  } catch { return { summary: null, rows: [] }; }
}

// Human ground truth for calibration: the jobs the candidate actually applied to
// or rejected, with their model score + description. This is the *external* signal
// that keeps calibration from converging on the model's own mean.
export function getHumanLabeledJobs() {
  return db.prepare(
    `SELECT id, job_title, company_name, location, match_percentage, match_reasoning,
            substr(job_description_raw, 1, 1500) AS job_description_raw, status
     FROM jobs WHERE status IN ('APPLIED','REJECTED') ORDER BY status, match_percentage DESC`
  ).all();
}
// A spread sample: the current tails (highest + lowest scored jobs) so the eval can
// measure whether a proposal preserves dispersion, not just fixes the labeled set.
export function getSpreadSample(n = 40) {
  const half = Math.max(1, Math.floor(n / 2));
  const hi = db.prepare(`SELECT id, job_title, company_name, location, match_percentage,
      substr(job_description_raw,1,1500) AS job_description_raw FROM jobs ORDER BY match_percentage DESC LIMIT ?`).all(half);
  const lo = db.prepare(`SELECT id, job_title, company_name, location, match_percentage,
      substr(job_description_raw,1,1500) AS job_description_raw FROM jobs ORDER BY match_percentage ASC LIMIT ?`).all(half);
  const seen = new Set();
  return [...hi, ...lo].filter((j) => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}

// ---------------------------------------------------------------------------
// Digest helpers: high-scoring jobs that haven't been emailed yet, and a way
// to mark a batch as emailed. Drives the email digest (manual + scheduled).
// ---------------------------------------------------------------------------
export function unnotifiedHighScore(minScore) {
  return db
    .prepare(
      `SELECT id, job_title, company_name, location, job_url, match_percentage, match_reasoning, tier
         FROM jobs
        WHERE match_percentage >= ?
          AND status != 'REJECTED'
          AND notified_at IS NULL
        ORDER BY match_percentage DESC, scraped_at DESC`
    )
    .all(minScore);
}
export function markNotified(ids) {
  if (!ids || !ids.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare("UPDATE jobs SET notified_at = ? WHERE id = ?");
  const tx = db.transaction((list) => { for (const id of list) stmt.run(now, id); });
  tx(ids);
}

// ---------------------------------------------------------------------------
// Error log: persisted so the user can review/export failures (e.g. auto-apply).
// ---------------------------------------------------------------------------
export function logError({ context = "", job_id = null, message = "", detail = "" } = {}) {
  try {
    db.prepare(
      "INSERT INTO error_log (id, at, context, job_id, message, detail) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(uuid(), new Date().toISOString(), String(context).slice(0, 200),
      job_id, String(message).slice(0, 1000), String(detail).slice(0, 4000));
    // Keep only the most recent 300 entries.
    db.prepare(
      "DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY at DESC LIMIT 300)"
    ).run();
  } catch { /* never let logging throw */ }
}
export function listErrors(limit = 300) {
  return db.prepare("SELECT * FROM error_log ORDER BY at DESC LIMIT ?").all(limit);
}
export function clearErrors() {
  const n = db.prepare("SELECT COUNT(*) c FROM error_log").get().c;
  db.prepare("DELETE FROM error_log").run();
  return n;
}

export function addStatusLog(jobId, from, to, note) {
  db.prepare(
    "INSERT INTO job_status_log (id, job_id, from_status, to_status, note) VALUES (?,?,?,?,?)"
  ).run(uuid(), jobId, from, to, note);
}

export function importJobs(rows) {
  const tx = db.transaction((list) => {
    for (const j of list) {
      try {
        INSERT_JOB.run({
          id: j.id || uuid(),
          job_title: j.job_title,
          company_name: j.company_name,
          location: j.location ?? "",
          job_description_raw: j.job_description_raw ?? "",
          match_percentage: Number(j.match_percentage) || 0,
          match_reasoning: j.match_reasoning ?? "",
          tier: j.tier ?? "TIER_3",
          status: j.status ?? "SCRAPED",
          salary_min: j.salary_min ?? null,
          salary_max: j.salary_max ?? null,
          salary_currency: j.salary_currency ?? null,
          salary_period: j.salary_period ?? null,
          salary_raw: j.salary_raw ?? null,
          posted_at: j.posted_at ?? null,
          posted_at_raw: j.posted_at_raw ?? null,
          job_url: j.job_url ?? null,
          scraped_at: j.scraped_at ?? new Date().toISOString(),
          applied_at: j.applied_at ?? null,
        });
      } catch (e) {
        // skip duplicate ids on re-import
      }
    }
  });
  tx(rows);
}

export { db, uuid };
