// Import your existing Supabase data (profiles.csv, jobs.csv, job_status_log.csv)
// into the local SQLite database.
//
//   node src/import-supabase.js <folder-with-csvs>
//   node src/import-supabase.js              (defaults to ./import)
//
// Safe to re-run: profile is replaced, jobs are upserted by id.
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { importProfile, importJobs, addStatusLog, db } from "./db.js";

const dir = process.argv[2] || path.resolve(process.cwd(), "import");

function read(name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return null;
  return parse(fs.readFileSync(p, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

// Postgres exports null numbers as "" and arrays as "{a,b}" / "{}".
function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pgArray(v) {
  if (!v || v === "{}" || v === "[]") return [];
  if (v.startsWith("[")) {
    try { return JSON.parse(v); } catch { /* fall through */ }
  }
  // {"a","b"} style
  const inner = v.replace(/^\{|\}$/g, "");
  if (!inner.trim()) return [];
  return inner
    .split(/","|,/)
    .map((s) => s.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
}
function jsonOr(v, fallback) {
  if (!v) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

console.log(`Importing from: ${dir}`);

const profiles = read("profiles.csv");
if (profiles && profiles.length) {
  const p = profiles[0];
  importProfile({
    id: p.id,
    base_resume_text: p.base_resume_text ?? "",
    base_cover_letter_text: p.base_cover_letter_text ?? "",
    target_preferences: jsonOr(p.target_preferences, {}),
    negative_feedback_corpus: pgArray(p.negative_feedback_corpus),
    application_profile: jsonOr(p.application_profile, {}),
  });
  console.log("  ✓ profile imported");
} else {
  console.log("  – no profiles.csv found, skipping");
}

const jobs = read("jobs.csv");
if (jobs && jobs.length) {
  const rows = jobs.map((j) => ({
    id: j.id,
    job_title: j.job_title,
    company_name: j.company_name,
    location: j.location ?? "",
    job_description_raw: j.job_description_raw ?? "",
    match_percentage: num(j.match_percentage) ?? 0,
    match_reasoning: j.match_reasoning ?? "",
    tier: j.tier || "TIER_3",
    status: j.status || "SCRAPED",
    salary_min: num(j.salary_min),
    salary_max: num(j.salary_max),
    salary_currency: j.salary_currency || null,
    salary_period: j.salary_period || null,
    salary_raw: j.salary_raw || null,
    posted_at: j.posted_at || null,
    posted_at_raw: j.posted_at_raw || null,
    job_url: j.job_url || null,
    scraped_at: j.scraped_at || new Date().toISOString(),
    applied_at: j.applied_at || null,
  }));
  // importJobs writes a default "scraped" status log per row; clear logs first
  // so a re-import doesn't pile up duplicates, then load the real log below.
  db.prepare("DELETE FROM job_status_log").run();
  db.prepare("DELETE FROM jobs").run();
  importJobs(rows);
  console.log(`  ✓ ${rows.length} jobs imported`);
} else {
  console.log("  – no jobs.csv found, skipping");
}

const logs = read("job_status_log.csv");
if (logs && logs.length) {
  // Replace the auto-generated insert logs with the real history.
  db.prepare("DELETE FROM job_status_log").run();
  const known = new Set(db.prepare("SELECT id FROM jobs").all().map((r) => r.id));
  let n = 0;
  for (const l of logs) {
    if (!known.has(l.job_id)) continue;
    db.prepare(
      "INSERT INTO job_status_log (id, job_id, from_status, to_status, note, created_at) VALUES (?,?,?,?,?,?)"
    ).run(
      l.id,
      l.job_id,
      l.from_status || null,
      l.to_status,
      l.note || null,
      l.created_at || new Date().toISOString()
    );
    n++;
  }
  console.log(`  ✓ ${n} status-log entries imported`);
}

console.log("Done. Start the app with:  npm start");
