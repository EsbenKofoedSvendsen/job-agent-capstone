// In-process scheduler: runs the scrape on a live-editable interval and emails a
// digest of high-scoring jobs that haven't been emailed yet. Interval, email
// threshold, and which weekdays to skip are stored in the DB (see
// getScheduleSettings) so they can be changed from the UI without a redeploy.
//
// The env var SCRAPE_INTERVAL_HOURS still GATES whether this instance schedules
// at all (so a local copy stays quiet); the actual timing comes from the DB.
import { config, aiConfigured } from "./config.js";
import { runScrape, isScraping } from "./scraper.js";
import { sendJobDigest, digestReady } from "./notify.js";
import { setMeta, getScheduleSettings, unnotifiedHighScore, markNotified } from "./db.js";

// Email every high-scoring job that hasn't been emailed yet (manual OR
// scheduled scrapes feed this), then mark them. Marks only AFTER a successful
// send, so a transient failure retries next time.
export async function sendPendingDigest() {
  if (!digestReady()) return { emailed: 0, skipped: "digest not configured" };
  const minScore = getScheduleSettings().digestMinScore;
  const matches = unnotifiedHighScore(minScore);
  if (!matches.length) return { emailed: 0 };
  await sendJobDigest(matches, minScore);
  markNotified(matches.map((m) => m.id));
  return { emailed: matches.length };
}

// One scheduled scrape + digest. Records the run time for the dashboard.
export async function runScheduledScrape() {
  // scheduled: browser-path sources run only on the first slot of the day
  const result = await runScrape({ scheduled: true });
  setMeta("last_scrape_auto", JSON.stringify({ at: new Date().toISOString(), inserted: result.total_inserted }));
  let emailed = 0;
  try {
    emailed = (await sendPendingDigest()).emailed;
  } catch (e) {
    console.error("[scheduler] digest email failed:", e instanceof Error ? e.message : e);
  }
  return { inserted: result.total_inserted, emailed };
}

const CHECK_INTERVAL_MS = 30_000; // wake every 30s and see if a run is due
const SLOT_WINDOW_MS = 5 * 60 * 1000; // fire a slot up to 5 min late (covers delays)

let ticker = null;
let nextRunAt = null;
const firedSlots = new Set(); // "YYYY-M-D HH:MM" slots already run this process

// Epoch ms of the next configured run-time not on a skipped day. Uses the
// process timezone (TZ env), so times are interpreted in local time. Display only.
function computeNextRunAt() {
  const { times, skipDays } = getScheduleSettings();
  if (!times.length) { nextRunAt = null; return; }
  const now = Date.now();
  const base = new Date();
  for (let off = 0; off < 14; off++) {
    const d = new Date(base);
    d.setDate(base.getDate() + off);
    if (skipDays.includes(d.getDay())) continue;
    for (const t of times) { // sorted ascending
      const [hh, mm] = t.split(":").map(Number);
      const cand = new Date(d);
      cand.setHours(hh, mm, 0, 0);
      if (cand.getTime() > now) { nextRunAt = cand.getTime(); return; }
    }
  }
  nextRunAt = null;
}

// Self-healing: runs every 30s. A hung/slow scrape can't freeze it (unlike a
// chained setTimeout) — the interval keeps firing and the lock prevents overlap.
async function tick() {
  computeNextRunAt(); // keep the dashboard countdown fresh
  const { times, skipDays } = getScheduleSettings();
  const now = new Date();
  if (skipDays.includes(now.getDay())) return; // quiet day

  for (const t of times) {
    const [hh, mm] = t.split(":").map(Number);
    const slot = new Date(now); slot.setHours(hh, mm, 0, 0);
    const diff = now.getTime() - slot.getTime();
    if (diff < 0 || diff >= SLOT_WINDOW_MS) continue; // not in this slot's window
    const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${t}`;
    if (firedSlots.has(key)) continue;
    if (isScraping()) { console.warn("[scheduler] slot due but a scrape is running — will retry."); return; }
    if (!aiConfigured()) { firedSlots.add(key); console.warn("[scheduler] slot due but AI not configured."); return; }

    firedSlots.add(key);
    if (firedSlots.size > 60) { const keep = [...firedSlots].slice(-20); firedSlots.clear(); keep.forEach((k) => firedSlots.add(k)); }
    try {
      console.log(`[scheduler] running scheduled scrape (slot ${t})…`);
      const r = await runScheduledScrape();
      console.log(`[scheduler] inserted ${r.inserted}, emailed ${r.emailed}`);
    } catch (e) {
      console.error("[scheduler] run failed:", e instanceof Error ? e.message : e);
    }
    return; // one run per tick
  }
}

export function getSchedulerStatus() {
  const s = getScheduleSettings();
  return {
    enabled: Boolean(config.digest.intervalHours), // env gate for this instance
    times: s.times,
    digestMinScore: s.digestMinScore,
    skipDays: s.skipDays,
    nextRunAt,
    running: isScraping(),
  };
}

export function startScheduler() {
  if (!config.digest.intervalHours) return; // disabled on this instance
  computeNextRunAt();
  ticker = setInterval(() => { tick().catch((e) => console.error("[scheduler] tick error:", e)); }, CHECK_INTERVAL_MS);
  const s = getScheduleSettings();
  console.log(
    `[scheduler] times [${s.times.join(", ")}] · digest >= ${s.digestMinScore} · ` +
      `skip days [${s.skipDays.join(",")}] · checking every 30s · email ${digestReady() ? "→ " + config.digest.to : "(not configured)"}`
  );
}

// Re-read settings (the ticker keeps running; just refresh the displayed next run).
export function rescheduleScheduler() {
  computeNextRunAt();
}

export function stopScheduler() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  nextRunAt = null;
}
