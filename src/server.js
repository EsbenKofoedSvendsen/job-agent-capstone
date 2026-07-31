import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { config, aiConfigured } from "./config.js";
import {
  getProfile, updateProfile, listJobs, getJob, updateJob, deleteJob, clearJobs,
  deleteApplied, getSalaryInsights,
  setMeta, getMeta, logError, listErrors, clearErrors,
  getScheduleSettings, setScheduleSettings, getRescoreStats, getSourceHealth,
  getScoringSettings, setScoringSettings,
  getCalibrationProposal, clearCalibrationProposal, getRescoreBenchmark,
} from "./db.js";
import { runScrape, rescoreBoard, isScraping } from "./scraper.js";
import { tailorApplication, scoreJobsBatch, extractRequirementSignal, DEFAULT_SCORING_RUBRIC, DEFAULT_CALIBRATION_EXAMPLES } from "./ai.js";
import { closeBrowser } from "./browser.js";
import { fetchLatestCode } from "./twofa.js";
import { startScheduler, stopScheduler, runScheduledScrape, sendPendingDigest, getSchedulerStatus, rescheduleScheduler } from "./scheduler.js";
import { runCalibration, calibrationStatus } from "./calibrate.js";
import { digestReady } from "./notify.js";

const parseMeta = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

const app = express();

// Optional HTTP Basic Auth. When APP_PASSWORD is set (recommended for any
// public host), every request must carry it. The browser caches the
// credentials and replays them on later requests — including the SSE stream.
// Timing-safe password comparison (hash first so lengths always match).
const safeEq = (a, b) => {
  if (!a || !b) return false;
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

if (config.appPassword) {
  app.use((req, res, next) => {
    const [, b64 = ""] = (req.headers.authorization || "").split(" ");
    const [, pass = ""] = Buffer.from(b64, "base64").toString().split(":");
    if (safeEq(pass, config.appPassword)) { req.role = "admin"; return next(); }
    if (config.viewerPassword && safeEq(pass, config.viewerPassword)) { req.role = "viewer"; return next(); }
    res.set("WWW-Authenticate", 'Basic realm="Job Agent"');
    return res.status(401).send("Authentication required");
  });

  // Viewer = read-only demo access. Only GET is allowed, and never the two
  // GETs that act or expose personal data: the SSE endpoint (it STARTS a
  // scrape) and the profile (it contains the résumé). Enforced here so the
  // API is safe regardless of what the UI shows.
  app.use((req, res, next) => {
    if (req.role !== "viewer") return next();
    if (req.method !== "GET" || req.path === "/api/scrape/stream" || req.path === "/api/profile" || req.path === "/api/settings/scoring") {
      return res.status(403).json({ error: "Read-only demo access — this action is admin-only." });
    }
    next();
  });
}

app.use(express.json({ limit: "4mb" }));
app.use(express.static(config.paths.public));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    logError({
      context: `${req.method} ${req.path}`,
      job_id: req.params?.id || null,
      message: e instanceof Error ? e.message : String(e),
      detail: e instanceof Error && e.stack ? e.stack : "",
    });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  });

// --- health ---------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    ai_ready: aiConfigured(),
    provider: config.ai.provider,
    model: config.ai.model,
    models: config.ai.models,
    rescore_threshold: config.ai.rescoreThreshold,
    resume_configured: Boolean(getProfile().resume_pdf_path),
    scheduler_hours: config.digest.intervalHours || 0,
    digest_ready: digestReady(),
    digest_min_score: config.digest.minScore,
  });
});

// Manually run the scheduled scrape + digest right now (handy for testing the
// email and for external cron). Runs synchronously; returns a summary.
app.post("/api/scrape/run", wrap(async (req, res) => {
  if (!aiConfigured()) return res.status(400).json({ error: "AI not configured (set AI_API_KEY)." });
  const result = await runScheduledScrape();
  res.json({ ok: true, ...result });
}));

// Score a pasted job posting against the profile WITHOUT saving it — a tester
// for evaluating/tuning the scoring calibration.
app.post("/api/jobs/score-test", wrap(async (req, res) => {
  if (!aiConfigured()) return res.status(400).json({ error: "AI not configured (set AI_API_KEY)." });
  const b = req.body || {};
  const job = {
    job_title: String(b.job_title || "").trim(),
    company_name: String(b.company_name || "").trim() || "Test Company",
    location: String(b.location || "").trim(),
    job_description_raw: String(b.job_description_raw || "").trim(),
  };
  if (!job.job_title || job.job_description_raw.length < 20) {
    return res.status(400).json({ error: "Provide at least a title and a description (20+ chars)." });
  }
  const [result] = await scoreJobsBatch([job], getProfile());
  res.json({ ok: true, ...result, requirement: extractRequirementSignal(job.job_description_raw) });
}));

// Re-score every job on the board with the current scoring prompt (applies
// calibration changes to existing jobs; drops ones that fall below min_score).
app.post("/api/jobs/rescore", wrap(async (req, res) => {
  if (!aiConfigured()) return res.status(400).json({ error: "AI not configured (set AI_API_KEY)." });
  if (isScraping()) return res.status(409).json({ error: "A scrape is running — try again when it finishes." });
  const result = await rescoreBoard();
  res.json({ ok: true, ...result });
}));

// Dashboard status: scheduler timing + last scrape times + digest config.
app.get("/api/status", wrap((req, res) => {
  const sched = getSchedulerStatus();
  res.json({
    role: req.role || "admin",
    scheduler: sched,
    last_scrape_auto: parseMeta(getMeta("last_scrape_auto")),
    last_scrape_manual: parseMeta(getMeta("last_scrape_manual")),
    digest_ready: digestReady(),
    digest_min_score: sched.digestMinScore,
  });
}));

// Live-editable schedule + email settings (interval, email threshold, skip days).
app.get("/api/settings/schedule", wrap((req, res) => res.json(getScheduleSettings())));
app.put("/api/settings/schedule", wrap((req, res) => {
  const updated = setScheduleSettings(req.body || {});
  rescheduleScheduler();
  res.json(updated);
}));

// Live-editable scoring prompts: the rubric + one-shot calibration examples the
// scorer applies to every job. GET returns the effective text (override or the
// built-in default) plus the defaults so the UI can offer "reset to default".
// Admin-only (viewers are blocked above).
app.get("/api/settings/scoring", wrap((req, res) => {
  const s = getScoringSettings();
  res.json({
    rubric: s.rubric || DEFAULT_SCORING_RUBRIC,
    calibration: s.calibration || DEFAULT_CALIBRATION_EXAMPLES,
    defaultRubric: DEFAULT_SCORING_RUBRIC,
    defaultCalibration: DEFAULT_CALIBRATION_EXAMPLES,
    usingDefaultRubric: !s.rubric,
    usingDefaultCalibration: !s.calibration,
  });
}));
app.put("/api/settings/scoring", wrap((req, res) => {
  const b = req.body || {};
  // Storing text that equals the built-in default (or is blank) = fall back to
  // the default, so future default changes still flow through.
  const norm = (v, def) =>
    typeof v === "string" && v.trim() && v.trim() !== def.trim() ? v : "";
  const saved = setScoringSettings({
    rubric: norm(b.rubric, DEFAULT_SCORING_RUBRIC),
    calibration: norm(b.calibration, DEFAULT_CALIBRATION_EXAMPLES),
  });
  res.json({
    rubric: saved.rubric || DEFAULT_SCORING_RUBRIC,
    calibration: saved.calibration || DEFAULT_CALIBRATION_EXAMPLES,
    usingDefaultRubric: !saved.rubric,
    usingDefaultCalibration: !saved.calibration,
  });
}));

// Biweekly auto-calibration (Opus proposes new one-shot anchors; admin adopts).
// GET: current pending proposal + cadence. POST /run: trigger now (force). POST
// /adopt: apply the proposal to the live calibration. POST /dismiss: drop it.
// All admin-only (POSTs blocked for viewers; GET is harmless status).
app.get("/api/calibration", wrap((req, res) => {
  res.json({ status: calibrationStatus(), proposal: getCalibrationProposal() });
}));
app.post("/api/calibration/run", wrap(async (req, res) => {
  const result = await runCalibration({ force: true });
  res.json(result);
}));
app.post("/api/calibration/adopt", wrap((req, res) => {
  const p = getCalibrationProposal();
  if (!p || !p.proposedCalibration) return res.status(404).json({ error: "no pending proposal" });
  const saved = setScoringSettings({ calibration: p.proposedCalibration });
  clearCalibrationProposal();
  res.json({ ok: true, adopted: true, calibration: saved.calibration });
}));
app.post("/api/calibration/dismiss", wrap((req, res) => {
  clearCalibrationProposal();
  res.json({ ok: true, dismissed: true });
}));

// --- jobs -----------------------------------------------------------------
// Viewers see the board but never the owner's tailored documents.
const redactJob = (req, j) =>
  req.role === "viewer" ? { ...j, tailored_resume_text: null, tailored_cover_letter_text: null } : j;

app.get("/api/jobs", wrap((req, res) => res.json(listJobs().map((j) => redactJob(req, j)))));

app.get("/api/jobs/:id", wrap((req, res) => {
  const data = getJob(req.params.id);
  if (!data) return res.status(404).json({ error: "not found" });
  res.json({ ...data, ...redactJob(req, data) });
}));

app.patch("/api/jobs/:id", wrap((req, res) => {
  const updated = updateJob(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
}));

// Clear the whole board (keeps your profile/settings).
app.delete("/api/jobs", wrap((req, res) => {
  const removed = clearJobs();
  res.json({ ok: true, removed });
}));

// Remove only jobs already marked applied. MUST precede "/api/jobs/:id" so the
// literal path wins over the :id param.
app.delete("/api/jobs/applied", wrap((req, res) => {
  const removed = deleteApplied();
  res.json({ ok: true, removed });
}));

app.delete("/api/jobs/:id", wrap((req, res) => {
  deleteJob(req.params.id);
  res.json({ ok: true });
}));

// Reject + record feedback so future scoring learns from it.
app.post("/api/jobs/:id/reject", wrap((req, res) => {
  const data = getJob(req.params.id);
  if (!data) return res.status(404).json({ error: "not found" });
  const j = data.job;
  updateJob(j.id, { status: "REJECTED", tier: "TIER_3" });
  const profile = getProfile();
  const snippet = `Rejected: ${j.job_title} @ ${j.company_name}. ${(j.job_description_raw || "").slice(0, 400)}`;
  const corpus = [snippet, ...(profile.negative_feedback_corpus || [])].slice(0, 100);
  updateProfile({ negative_feedback_corpus: corpus });
  res.json({ ok: true });
}));

app.post("/api/jobs/:id/reopen", wrap((req, res) => {
  const updated = updateJob(req.params.id, { status: "PENDING_APPROVAL" });
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
}));

// Tailor resume + cover letter.
app.post("/api/jobs/:id/tailor", wrap(async (req, res) => {
  if (!aiConfigured()) return res.status(400).json({ error: "AI not configured (set AI_API_KEY in .env)." });
  const data = getJob(req.params.id);
  if (!data) return res.status(404).json({ error: "not found" });
  updateJob(data.job.id, { status: "TAILORING" });
  const profile = getProfile();
  const out = await tailorApplication(data.job, profile);
  const updated = updateJob(data.job.id, {
    tailored_resume_text: out.tailored_resume,
    tailored_cover_letter_text: out.tailored_cover_letter,
    status: "TAILORED",
  });
  res.json(updated);
}));

// --- scrape (SSE progress) ------------------------------------------------
app.get("/api/scrape/stream", async (req, res) => {
  if (!aiConfigured()) {
    res.status(400).json({ error: "AI not configured (set AI_API_KEY in .env)." });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    const urls = req.query.urls ? String(req.query.urls).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const result = await runScrape({ urls, onEvent: send });
    setMeta("last_scrape_manual", JSON.stringify({ at: new Date().toISOString(), inserted: result.total_inserted }));
    // Email any new high-scoring matches from this run too.
    try {
      const d = await sendPendingDigest();
      if (d.emailed) send({ type: "emailed", count: d.emailed });
    } catch (e) {
      send({ type: "email_error", error: e instanceof Error ? e.message : String(e) });
    }
  } catch (e) {
    send({ type: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    send({ type: "end" });
    res.end();
  }
});

// --- rescore impact (Sonnet vs Haiku deltas) ------------------------------
app.get("/api/rescore-stats", wrap((req, res) => res.json(getRescoreStats())));

app.get("/api/salary-insights", wrap((req, res) => res.json(getSalaryInsights())));

// Sonnet-vs-Opus benchmark from the one-time board re-score onto Opus 4.8.
app.get("/api/rescore-benchmark", wrap((req, res) => res.json(getRescoreBenchmark())));

app.get("/api/sources/health", wrap((req, res) => res.json(getSourceHealth())));

// --- error log ------------------------------------------------------------
app.get("/api/errors", wrap((req, res) => res.json(listErrors())));
app.delete("/api/errors", wrap((req, res) => res.json({ ok: true, removed: clearErrors() })));

// --- profile / settings ---------------------------------------------------
app.get("/api/profile", wrap((req, res) => res.json(getProfile())));

app.put("/api/profile", wrap((req, res) => {
  const allowed = [
    "base_resume_text", "base_cover_letter_text",
    "target_preferences", "negative_feedback_corpus",
  ];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  res.json(updateProfile(patch));
}));

// --- 2FA helper -----------------------------------------------------------
app.post("/api/2fa", wrap(async (req, res) => {
  const out = await fetchLatestCode(req.body || {});
  res.json(out);
}));

// SPA fallback
app.get("*", (req, res) => res.sendFile(path.join(config.paths.public, "index.html")));

const server = app.listen(config.port, () => {
  console.log(`\n  Job Agent Local running →  http://localhost:${config.port}\n`);
  if (!aiConfigured()) console.log("  ⚠  AI_API_KEY not set — add it to .env, then restart.\n");
  startScheduler();
});

async function shutdown() {
  console.log("\nShutting down…");
  stopScheduler();
  await closeBrowser();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
