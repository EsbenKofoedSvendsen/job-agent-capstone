// ---------------------------------------------------------------------------
// Biweekly auto-calibration of the one-shot scoring anchors.
//
// Every ~14 days this asks Opus to propose an improved CALIBRATION EXAMPLES block
// from the candidate's *real* apply/reject decisions (the model's residual
// errors), then A/B-evals the proposal against the current anchors on a fixed
// eval set and stores it as a PENDING proposal for the admin to adopt/dismiss.
//
// It is designed NOT to converge toward a flat mean:
//   - anchors on human ground truth, not the model's own score consensus;
//   - the Opus prompt must preserve the poles and keep/widen the spread;
//   - the eval GATE rejects any proposal that shrinks dispersion (variance floor)
//     or loses a pole, independent of what the model claims.
// Adoption is always manual, so a failing proposal can never touch live scoring.
// ---------------------------------------------------------------------------
import {
  getProfile, getScoringSettings, getHumanLabeledJobs, getSpreadSample,
  setCalibrationProposal, getMeta, setMeta, getRescoreStats,
} from "./db.js";
import {
  proposeCalibration, scoreForEval, DEFAULT_CALIBRATION_EXAMPLES,
  beginUsageCapture, endUsageCapture,
} from "./ai.js";

export const CALIBRATION_INTERVAL_DAYS = 14;
const APPLIED_TARGET = 78; // applied jobs should score at least this
const REJECTED_TARGET = 58; // rejected jobs should score at most this
const SPREAD_FLOOR_RATIO = 0.9; // proposal must keep >=90% of current dispersion
const ACC_MARGIN = 0.6; // labelError deltas smaller than this are LLM-eval noise, not signal

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

export function calibrationDue() {
  const last = getMeta("calibration_last_run_day");
  if (!last) return true;
  return daysBetween(today(), last) >= CALIBRATION_INTERVAL_DAYS;
}
export function calibrationStatus() {
  const last = getMeta("calibration_last_run_day") || null;
  return {
    lastRun: last,
    intervalDays: CALIBRATION_INTERVAL_DAYS,
    due: calibrationDue(),
    daysUntilNext: last ? Math.max(0, CALIBRATION_INTERVAL_DAYS - daysBetween(today(), last)) : 0,
  };
}

// --- small stats helpers ---------------------------------------------------
const pstdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};
// Every "-> NN" score an anchor block declares.
const anchorScores = (text) =>
  [...String(text).matchAll(/->\s*(\d{1,3})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 0 && n <= 100);
// The poles must survive: a high (>=85 — the realistic ceiling; the model never
// scores real jobs above ~88), a low (<=15), and a hard-cap (50-56).
const polesIntact = (text) => {
  const s = anchorScores(text);
  return s.some((n) => n >= 85) && s.some((n) => n <= 15) && s.some((n) => n >= 50 && n <= 56);
};

const jobLine = (j) =>
  `  - "${j.job_title}" @ ${j.company_name} (model scored ${j.match_percentage}): ${String(j.job_description_raw || "").replace(/\s+/g, " ").slice(0, 220)}`;

// labelError over the labeled subset: how far scores sit from the human verdict.
function labelError(labeled, scoreById) {
  if (!labeled.length) return 0;
  let sum = 0;
  for (const j of labeled) {
    const s = scoreById.get(j.id);
    if (s == null) continue;
    sum += j.status === "APPLIED" ? Math.max(0, APPLIED_TARGET - s) : Math.max(0, s - REJECTED_TARGET);
  }
  return +(sum / labeled.length).toFixed(1);
}

// Score an eval set with a given calibration and return id -> score.
async function scoreSet(jobs, profile, calibrationText) {
  const out = await scoreForEval(jobs, profile, calibrationText);
  const map = new Map();
  jobs.forEach((j, i) => { const r = out[i]; if (r && !r.inconclusive) map.set(j.id, r.match_percentage); });
  return map;
}

// Run one calibration cycle. `force` bypasses the 14-day cadence (manual trigger).
export async function runCalibration({ force = false } = {}) {
  if (!force && !calibrationDue()) return { skipped: "not_due", ...calibrationStatus() };

  const labeled = getHumanLabeledJobs();
  if (labeled.length < 3) {
    setMeta("calibration_last_run_day", today());
    return { skipped: "insufficient_signal", labeled: labeled.length };
  }

  const profile = getProfile();
  const currentCalibration = (getScoringSettings().calibration || "").trim() || DEFAULT_CALIBRATION_EXAMPLES;

  const applied = labeled.filter((j) => j.status === "APPLIED");
  const rejected = labeled.filter((j) => j.status === "REJECTED");
  const appliedUnderscored = applied.filter((j) => j.match_percentage < APPLIED_TARGET).map(jobLine).join("\n");
  const rejectedOverscored = rejected.filter((j) => j.match_percentage > REJECTED_TARGET).map(jobLine).join("\n");
  let cascade = "";
  try {
    cascade = (getRescoreStats().biggest || []).slice(0, 8)
      .map((r) => `  - "${r.job_title}" @ ${r.company_name}: cheap ${r.first_score} -> strong ${r.final_score} (${r.delta > 0 ? "+" : ""}${r.delta})`)
      .join("\n");
  } catch { cascade = ""; }

  beginUsageCapture();
  let proposed, evalReport, error = null;
  try {
    proposed = await proposeCalibration({
      currentCalibration, resume: profile.base_resume_text || "",
      signal: { appliedUnderscored, rejectedOverscored, cascade },
    });

    if (!proposed.calibration || anchorScores(proposed.calibration).length < 4) {
      throw new Error("Opus returned an unusable calibration block");
    }

    // A/B eval on labeled jobs (for accuracy) + spread sample (for dispersion).
    const spreadSample = getSpreadSample(40);
    const byId = new Map();
    for (const j of [...labeled, ...spreadSample]) if (!byId.has(j.id)) byId.set(j.id, j);
    const evalJobs = [...byId.values()];

    const curScores = await scoreSet(evalJobs, profile, currentCalibration);
    const propScores = await scoreSet(evalJobs, profile, proposed.calibration);

    const spreadCur = +pstdev([...curScores.values()]).toFixed(1);
    const spreadProp = +pstdev([...propScores.values()]).toFixed(1);
    const leCur = labelError(labeled, curScores);
    const leProp = labelError(labeled, propScores);
    const poles = polesIntact(proposed.calibration);
    const spreadOk = spreadProp >= SPREAD_FLOOR_RATIO * spreadCur;
    const accDelta = +(leCur - leProp).toFixed(1); // >0 = proposal is closer to your calls
    const improves = accDelta > ACC_MARGIN;         // clearly better, beyond eval noise
    const notWorse = accDelta > -ACC_MARGIN;        // not clearly worse (within eval noise)

    evalReport = {
      nLabeled: labeled.length, nEval: evalJobs.length,
      labelErrorCurrent: leCur, labelErrorProposed: leProp,
      improvesAccuracy: improves, accWithinNoise: Math.abs(accDelta) <= ACC_MARGIN,
      spreadCurrent: spreadCur, spreadProposed: spreadProp, spreadFloor: +(SPREAD_FLOOR_RATIO * spreadCur).toFixed(1), spreadOk,
      polesIntact: poles,
      // Advisory gate: adopt-worthy if it holds the dispersion floor AND keeps the
      // poles AND isn't *clearly* worse on accuracy (a sub-noise wobble shouldn't
      // sink an otherwise-good set). Manual adoption is never blocked regardless.
      gatePass: notWorse && spreadOk && poles,
    };
  } catch (e) {
    error = e.message || String(e);
  }
  const usage = endUsageCapture();

  setMeta("calibration_last_run_day", today());
  if (error) return { error };

  const proposal = {
    created_at: new Date().toISOString(),
    model: "claude-opus-4-8",
    status: "pending",
    currentCalibration,
    proposedCalibration: proposed.calibration,
    rationale: proposed.rationale,
    eval: evalReport,
    cost: usage ? usage.cost : null,
  };
  setCalibrationProposal(proposal);
  console.log(`[calibrate] proposal ready · gate=${evalReport.gatePass ? "PASS" : "FAIL"} · labelErr ${evalReport.labelErrorCurrent}->${evalReport.labelErrorProposed} · spread ${evalReport.spreadCurrent}->${evalReport.spreadProposed} · est $${usage ? usage.cost : "?"}`);
  return { ok: true, proposal };
}
