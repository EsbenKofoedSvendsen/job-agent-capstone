// Provider-agnostic LLM layer. Works with Anthropic or any OpenAI-compatible
// endpoint (OpenAI, OpenRouter, Ollama, LM Studio, ...) using built-in fetch.
// No SDK dependency.
import { config } from "./config.js";
import { chunk, tierFor, mapWithConcurrency } from "./util.js";
import { getScheduleSettings, getScoringSettings, logRescore } from "./db.js";

const { provider, apiKey, model, baseUrl } = config.ai;

// Hard cap on any single AI request. Without this, a hung connection blocks the
// scrape forever (it once froze the whole scheduler — the request never returns,
// so the lock never releases and no further runs get scheduled).
const AI_TIMEOUT_MS = 90_000;

function extractJson(text) {
  if (!text) throw new Error("empty model response");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const body = fenced ?? text;
  // Grab the outermost {...} or [...]
  const firstObj = body.indexOf("{");
  const firstArr = body.indexOf("[");
  let start = firstObj;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) start = firstArr;
  const lastObj = body.lastIndexOf("}");
  const lastArr = body.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);
  const slice = start !== -1 && end !== -1 ? body.slice(start, end + 1) : body;
  return JSON.parse(slice);
}

// `cachePrefix`, when set, is a large block that repeats verbatim across many
// calls (e.g. the candidate resume during batch scoring). On Anthropic it's
// marked with cache_control so we don't re-pay input tokens for it on every
// call; on OpenAI-compatible endpoints (no manual cache control) it's just
// prepended to the user message.
//
// `schema`, when set, enables structured outputs on the Anthropic path
// (output_config.format json_schema): the response is guaranteed schema-valid
// JSON, so we JSON.parse it directly — no regex extraction, no parse-failure
// fallbacks. The OpenAI-compatible path ignores it (keeps json_object mode).
async function rawCall({ system, user, cachePrefix = null, maxTokens = 2000, json = true, schema = null, model: modelOverride = model, temperature = null, top_p = null }) {
  if (!apiKey) throw new Error("AI_API_KEY is not set (see .env).");

  // Newer Claude models (Opus 4.7/4.8, Sonnet 5, Fable/Mythos 5) reject sampling
  // params with a 400. Strip them centrally so a temperature set for the cheap
  // models never breaks a call routed to a strong model (e.g. the Opus rescore).
  if (/opus-4-[78]|opus-5|sonnet-5|fable-5|mythos-5/.test(modelOverride || "")) {
    temperature = null;
    top_p = null;
  }

  if (provider === "anthropic") {
    const userContent = cachePrefix
      ? [
          { type: "text", text: cachePrefix, cache_control: { type: "ephemeral" } },
          { type: "text", text: user },
        ]
      : user;
    // NOTE: no assistant-message prefill — newer models (e.g. Sonnet 4.6) 400 on
    // it. Structured outputs (schema) is the modern replacement.
    const messages = [{ role: "user", content: userContent }];
    const body = { model: modelOverride, max_tokens: maxTokens, system, messages };
    if (schema && json) body.output_config = { format: { type: "json_schema", schema } };
    if (temperature != null) body.temperature = temperature;
    if (top_p != null) body.top_p = top_p;
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    // Cache observability: cache_read=0 on repeated calls means the prefix is
    // below the model's cacheable minimum (Haiku 4.5: 4096 tokens) or a byte
    // in the prefix is changing — either way we want to see it in the logs.
    const u = data.usage || {};
    recordUsage(modelOverride, u);
    const trunc = data.stop_reason === "max_tokens" ? " TRUNCATED(max_tokens)" : "";
    console.log(`[ai] ${modelOverride} in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}${trunc}`);
    const text = (data.content ?? []).map((c) => c.text ?? "").join("");
    if (!json) return text;
    return schema ? JSON.parse(text) : extractJson(text);
  }

  // OpenAI-compatible
  const fullUser = cachePrefix ? `${cachePrefix}\n\n${user}` : user;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelOverride,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: fullUser },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(top_p != null ? { top_p } : {}),
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return json ? extractJson(text) : text;
}

// ---------------------------------------------------------------------------
// Per-run usage accounting. A scrape brackets its AI calls with begin/end and
// gets back totals + an estimated cost, so every scrape report shows what it
// actually cost — a regression announces itself in the logs instead of as a
// spent-budget email a month later.
// ---------------------------------------------------------------------------
const PRICES = [
  [/haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
  [/opus/i, 5, 25],
];
function priceFor(m) {
  for (const [re, i, o] of PRICES) if (re.test(m)) return [i, o];
  return [1, 5];
}
let usageAcc = null;
export function beginUsageCapture() {
  usageAcc = { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 };
}
export function endUsageCapture() {
  const u = usageAcc;
  usageAcc = null;
  if (u) u.cost = +u.cost.toFixed(4);
  return u;
}
function recordUsage(model, u) {
  if (!usageAcc || !u) return;
  const [pi, po] = priceFor(model);
  const inT = u.input_tokens || 0, outT = u.output_tokens || 0;
  const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  usageAcc.calls++;
  usageAcc.input += inT; usageAcc.output += outT;
  usageAcc.cache_read += cr; usageAcc.cache_write += cw;
  usageAcc.cost += (inT * pi + cw * pi * 1.25 + cr * pi * 0.1 + outT * po) / 1e6;
}

// Retry only transient failures: timeouts/network errors (no status), 429 and
// 5xx. A 400/401 is deterministic — retrying just doubles the cost of a hard
// failure.
const RETRYABLE_AI_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
async function call(opts) {
  try {
    return await rawCall(opts);
  } catch (e) {
    if (e && e.status && !RETRYABLE_AI_STATUS.has(e.status)) throw e;
    await new Promise((r) => setTimeout(r, 800));
    return rawCall(opts);
  }
}

// ---------------------------------------------------------------------------
// JSON Schemas for structured outputs. Every object needs additionalProperties
// false + full required lists (API requirement). Numeric min/max constraints
// aren't supported — the 0-100 clamp stays client-side.
// ---------------------------------------------------------------------------
const nullable = (t) => ({ anyOf: [{ type: t }, { type: "null" }] });

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          job_title: { type: "string" },
          company_name: { type: "string" },
          location: { type: "string" },
          job_description_raw: { type: "string" },
          salary_min: nullable("number"),
          salary_max: nullable("number"),
          salary_currency: nullable("string"),
          salary_period: nullable("string"),
          salary_raw: nullable("string"),
          posted_at_raw: nullable("string"),
          posted_days_ago: nullable("integer"),
          posted_date_iso: nullable("string"),
          job_url: nullable("string"),
        },
        required: [
          "job_title", "company_name", "location", "job_description_raw",
          "salary_min", "salary_max", "salary_currency", "salary_period", "salary_raw",
          "posted_at_raw", "posted_days_ago", "posted_date_iso", "job_url",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["jobs"],
  additionalProperties: false,
};

const SCORE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          match_percentage: { type: "integer" },
          match_reasoning: { type: "string" },
        },
        required: ["index", "match_percentage", "match_reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const TAILOR_SCHEMA = {
  type: "object",
  properties: {
    tailored_resume: { type: "string" },
    tailored_cover_letter: { type: "string" },
  },
  required: ["tailored_resume", "tailored_cover_letter"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// 1. Extract job postings from a scraped page
// ---------------------------------------------------------------------------
export async function extractJobs(content, sourceUrl) {
  const system =
    "You extract structured job postings from web page text. Respond with JSON only.";
  const user = `Extract job postings from this page. Return JSON {"jobs":[...]}.
Return up to 12 distinct openings. Only real job postings (skip nav links, footers, "see all jobs"). If none, return {"jobs":[]}.
If the page is a single job listing, return one entry.
Each job needs: job_title, company_name, location, job_description_raw (200-600 chars: key responsibilities + requirements).
If a salary is stated: salary_min, salary_max (numbers), salary_currency (USD/EUR...), salary_period (year|month|week|day|hour), salary_raw. Otherwise null.
If a posting date is visible: posted_at_raw (verbatim), posted_days_ago (integer; today=0, "3 days ago"=3, "2 weeks ago"=14), posted_date_iso (YYYY-MM-DD if a calendar date). Otherwise null. Do NOT guess dates.
If a direct link to the individual posting/apply page is visible (verbatim absolute URL), set job_url. Else null. Do NOT guess.

SOURCE URL: ${sourceUrl}

PAGE CONTENT:
${content.slice(0, 24000)}`;

  let parsed;
  try {
    parsed = await call({ system, user, maxTokens: 8000, json: true, schema: EXTRACT_SCHEMA, model: config.ai.models.extract });
  } catch {
    return { jobs: [], error: "AI extraction failed for this page." };
  }
  const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  return { jobs };
}

// Pull explicit experience requirements out of a full job description so the
// scorer always sees the years bar even when the description gets sliced (it's
// often in a "qualifications" section appended after the main text).
export function extractRequirementSignal(desc) {
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
  // Normalize spelled-out numbers before "years" (e.g. "Minimum two years" -> "2 years").
  const text = String(desc || "").replace(/\s+/g, " ")
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b(?=[\s-]*\+?\s*years?\b)/gi,
      (w) => String(WORDS[w.toLowerCase()] ?? w));
  const hits = [];
  const re = /(\d{1,2})\s*(?:\+|to|-|–|—)?\s*(\d{1,2})?\s*\+?\s*years?\b[^.;|]{0,45}/gi;
  let m;
  while ((m = re.exec(text)) !== null && hits.length < 3) {
    const ctx = text.slice(Math.max(0, m.index - 35), m.index + m[0].length).trim();
    if (/experien|minimum|at least|required|relevant|background|track record|\d\s*\+/i.test(ctx)) {
      hits.push(ctx.slice(-90));
    }
  }
  return hits.length ? [...new Set(hits)].join(" ; ") : "none detected";
}

// Deterministic seniority gate. The scoring rubric HARD-CAPS at 55 (below
// min_score) any job whose stated minimum exceeds the candidate by ~3+ years —
// that part of the rubric is mechanical, so jobs that trip it can be discarded
// WITHOUT an AI call. Conservative by design: returns the LOWEST years bar
// found in unambiguous requirement context, skips "preferred/nice-to-have"
// mentions, and returns 0 (no gate) when nothing unambiguous is found — so
// borderline postings still go to the scorer, which applies the full rubric.
export function minYearsRequired(desc) {
  const text = String(desc || "").replace(/\s+/g, " ");
  const re = /(\d{1,2})\s*(?:\+|(?:-|–|—|to)\s*\d{1,2})?\s*\+?\s*years?\b/gi;
  const mins = [];
  let m;
  while ((m = re.exec(text)) !== null && mins.length < 6) {
    const ctx = text.slice(Math.max(0, m.index - 45), m.index + m[0].length + 55);
    if (!/experien|minimum|at least|required|must have|track record/i.test(ctx)) continue;
    if (/\bprefer|\bplus\b|nice.to.have|\bbonus\b|\bideal/i.test(ctx)) continue;
    mins.push(parseInt(m[1], 10));
  }
  return mins.length ? Math.min(...mins) : 0;
}

// ---------------------------------------------------------------------------
// 2. Score many jobs against the candidate (batched). `scorePass` does one pass
//    with a given model; `scoreJobsBatch` runs the cheap pass then escalates the
//    promising jobs to the stronger model (cascade).
// ---------------------------------------------------------------------------
// Built-in scoring guidance. These are the defaults the scorer uses unless an
// admin overrides them in Settings (persisted via getScoringSettings). Exported
// so the settings endpoint can show them and offer "reset to default".
export const DEFAULT_SCORING_RUBRIC = `SCORING RUBRIC
1. Infer the candidate's total years of experience and seniority level from the resume.
2. For each job, read its required experience: explicit minimums (e.g. "8+ years", "5-7 years", the
   "Stated experience requirement" line) AND the title's level
   (Intern < Analyst < Associate < Manager < Senior Manager < Director < VP < SVP/Principal/Head < Chief).
3. Apply seniority fit BEFORE topical fit. The STATED experience requirement (explicit years) is the PRIMARY
   signal; the TITLE is secondary — some industries (especially finance/banking) use senior-sounding titles
   like VP or Director for mid-level roles. When years are stated, judge against the years, not the title.
   - IN REACH (small or no penalty, score on substance): the role's stated experience range includes the
     candidate or sits just above (e.g. needs "5-8 years" and the candidate has ~5) — even if titled VP or
     Director. A senior title alone is NOT a disqualifier.
   - SOFT PENALTY (subtract ~15-25): a senior title with NO stated years bar, where the title/scope reads
     above the candidate, but the resume genuinely covers the substance.
   - HARD CAP at 55: the stated minimum clearly exceeds the candidate by ~3+ years (e.g. needs "8+" or
     "10-12 years" and the candidate has ~5), OR — when no years are stated — the title and scope are clearly
     far above (SVP / Principal / Head / Chief, or a Director/VP demanding heavy org leadership the resume
     lacks). Topical overlap does NOT lift a capped score.
   - NO penalty when the stated experience and seniority reasonably match — judge purely on substance.
4. Judge substance by TRANSFERABLE fit, not exact keyword match. When the seniority matches AND the
   candidate's core skills (strategy, product, transformation, analytics, stakeholder / cross-functional
   leadership, etc.) clearly overlap the role's MAIN responsibilities, treat it as a strong match even if the
   posting names niche specifics the resume does not list (a particular product area, tech stack, or
   sub-industry). Do NOT drop such a role below 80 only for missing niche/domain specifics — note the gap but
   keep the score high. Reserve large topical deductions for roles whose CORE function genuinely differs from
   the candidate's experience.
   FUNCTIONAL MISMATCH OVERRIDE: when the role's PRIMARY profession is one the candidate has never practiced
   (legal counsel, HR, sales / channel partnerships, software / ML / data engineering, data science,
   accounting / controllership, marketing, solutions architecture, design), score it BELOW 40. Transferable
   strategy / stakeholder / cross-functional skills do NOT rescue a different profession — never park these
   at 65-75.
5. Score bands AFTER the seniority + substance assessment:
   - 85-100: at the candidate's level with strong overlap on the role's core responsibilities (niche-domain
     gaps are fine). Award this freely — do NOT withhold it from genuine matches.
   - 70-84: solid but with a real CORE gap (different primary function, materially off-level, or thin evidence).
   - 50-69: weak/partial.  0-49: poor.`;

export const DEFAULT_CALIBRATION_EXAMPLES = `CALIBRATION EXAMPLES (anchor your scoring to these):
- "VP, Product Strategy" at a bank, stated "5-8 years experience": the stated range includes the candidate
  (~5 years) despite the VP title (finance titles run senior) -> IN REACH; strong core overlap in
  strategy/product/stakeholder leadership -> 88.
- "Director of Product, Payments" stated "10+ years leading product organizations": the stated minimum
  exceeds the candidate by ~5 years -> HARD CAP -> 52, regardless of perfect topical overlap.
- "Senior Product Manager, Growth" stated "4-6 years", core responsibilities = analytics, experimentation,
  cross-functional delivery; the posting names a niche tech stack the resume lacks -> level and core both
  match, niche gap only -> 86 (do NOT drop it to the 70s for the niche gap).
- "Counsel, Product & Regulatory" requiring 4+ years of legal experience: the candidate has no legal
  background -> FUNCTIONAL MISMATCH -> 12. The fintech setting and product-adjacency do NOT make this 70+.
- "Senior Manager, Data Science" requiring 7+ years of DS/engineering: no engineering or data-science
  background -> FUNCTIONAL MISMATCH -> 18, despite strong analytics and stakeholder skills.
- When a role requires "N+ years of product management": count the candidate's FULL years of product AND
  strategy work combined (~5), not only explicitly-titled product roles — do not under-credit to ~2.5.`;

async function scorePass(jobs, profile, scoreModel, calibrationOverride = null) {
  const batchSize = config.scrape.scoreBatchSize;
  const resume = (profile.base_resume_text ?? "").slice(0, 8000);
  const prefs = JSON.stringify(profile.target_preferences ?? {});
  const rejected = (profile.negative_feedback_corpus ?? []).slice(0, 12).join(" | ");

  const system =
    "You are a meticulous, realistic recruiter screening jobs for ONE candidate, like an ATS reviewer. " +
    "Seniority and years-of-experience fit is a primary, often decisive axis — never let topical or domain " +
    "overlap rescue a candidate who is under- or over-qualified. But do NOT suppress genuine matches: when " +
    "the candidate clearly meets the role's level and the substance overlaps, score it high. Respond with JSON only.";

  // The rubric + one-shot calibration are live-editable in Settings; fall back to
  // the built-in defaults whenever no override is saved (or it's blank).
  const sc = getScoringSettings();
  const rubric = sc.rubric && sc.rubric.trim() ? sc.rubric : DEFAULT_SCORING_RUBRIC;
  const calibration = calibrationOverride && calibrationOverride.trim()
    ? calibrationOverride
    : (sc.calibration && sc.calibration.trim() ? sc.calibration : DEFAULT_CALIBRATION_EXAMPLES);

  // Static across every batch -> cached prefix so prompt caching skips re-billing
  // the resume/rubric each call.
  const cachePrefix = `CANDIDATE RESUME:
${resume}

TARGET PREFERENCES: ${prefs}

PREVIOUSLY REJECTED (penalize similar): ${rejected || "none"}

${rubric}

${calibration}

In match_reasoning, state the role's level / required years vs the candidate's level and the decisive factor.`;

  const scoreGroup = async (group) => {
    const list = group
      .map(
        (j, i) =>
          `### JOB ${i}
Title: ${j.job_title}
Company: ${j.company_name}
Location: ${j.location ?? ""}
Stated experience requirement: ${extractRequirementSignal(j.job_description_raw)}
${(j.job_description_raw ?? "").slice(0, 3000)}`
      )
      .join("\n\n");

    const user = `Score each job 0-100 using the SCORING RUBRIC above (apply the seniority gate first).
Return JSON {"results":[{"index":0,"match_percentage":75,"match_reasoning":"..."}, ...]} with one entry per job, index matching the JOB number.
match_reasoning: for scores 65 and above, one terse sentence stating the role's level/required years vs the candidate's and the decisive factor. For scores below 65, a short phrase (max 8 words) naming only the decisive factor — these are discarded, do not waste words on them.

JOBS:
${list}`;

    let parsed;
    try {
      // temperature 0: scoring is a grading task — deterministic, reproducible
      // scores (and a noise-free calibration eval), not sampled variety.
      parsed = await call({ system, user, cachePrefix, maxTokens: 4000, json: true, schema: SCORE_SCHEMA, model: scoreModel, temperature: 0 });
    } catch {
      parsed = null;
    }
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    return group.map((_, i) => {
      const r = results.find((x) => Number(x.index) === i) ?? results[i];
      const raw = Number(r?.match_percentage);
      const ok = Number.isFinite(raw);
      const pct = ok ? Math.max(0, Math.min(100, Math.round(raw))) : 50;
      return {
        match_percentage: pct,
        match_reasoning: (r?.match_reasoning ?? "Automatic scoring was inconclusive.").slice(0, 800),
        tier: tierFor(pct),
        inconclusive: !ok,
      };
    });
  };

  // Warm-then-fan-out: the first batch runs alone so it WRITES the prompt cache
  // (an entry only becomes readable once the first response starts), then the
  // rest run concurrently and READ it. Firing all groups at once would make
  // every one pay the full uncached prefix price.
  const groups = chunk(jobs, batchSize);
  if (!groups.length) return [];
  const first = await scoreGroup(groups[0]);
  const rest = groups.length > 1
    ? await mapWithConcurrency(groups.slice(1), config.scrape.scoreConcurrency, scoreGroup)
    : [];
  return [first, ...rest].flat();
}

export async function scoreJobsBatch(jobs, profile) {
  const { score, rescore } = config.ai.models;
  // Cheap first pass over everything.
  const out = await scorePass(jobs, profile, score);

  // Retry any jobs the first pass couldn't parse a score for (transient model
  // hiccup) so they don't get stuck at the inconclusive fallback (50).
  const inc = [];
  out.forEach((r, i) => { if (r.inconclusive) inc.push(i); });
  if (inc.length) {
    const retry = await scorePass(inc.map((i) => jobs[i]), profile, score);
    inc.forEach((origIdx, k) => { if (retry[k] && !retry[k].inconclusive) out[origIdx] = retry[k]; });
  }

  // Cascade: re-score the promising ones with the stronger model. Skipped when
  // rescore == score (no second model configured), so cost only rises when set.
  // Threshold is live-editable from Settings (falls back to the env default).
  const thr = getScheduleSettings().rescoreThreshold ?? config.ai.rescoreThreshold;
  if (rescore && rescore !== score) {
    const idxs = [];
    out.forEach((r, i) => { if (!r.inconclusive && r.match_percentage > thr) idxs.push(i); });
    if (idxs.length) {
      const refined = await scorePass(idxs.map((i) => jobs[i]), profile, rescore);
      const logRows = [];
      idxs.forEach((origIdx, k) => {
        if (refined[k] && !refined[k].inconclusive) {
          // Record what Sonnet changed (before overwriting), for the impact chart —
          // including both models' reasoning so the move is explainable.
          logRows.push({
            job_title: jobs[origIdx].job_title, company_name: jobs[origIdx].company_name,
            first: out[origIdx].match_percentage, final: refined[k].match_percentage,
            first_reasoning: out[origIdx].match_reasoning, final_reasoning: refined[k].match_reasoning,
          });
          out[origIdx] = refined[k];
        }
      });
      try { logRescore(logRows); } catch { /* logging must never break scoring */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2b. Auto-calibration support. A single cheap pass with an explicit one-shot
//     calibration override lets the biweekly calibrator A/B a *proposed* set
//     against the current one on a fixed eval set, without touching live
//     scoring settings. `proposeCalibration` asks Opus for an improved set.
// ---------------------------------------------------------------------------
export async function scoreForEval(jobs, profile, calibrationText) {
  return scorePass(jobs, profile, config.ai.models.score, calibrationText || null);
}

const PROPOSE_CALIBRATION_SCHEMA = {
  type: "object",
  properties: {
    calibration: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["calibration", "rationale"],
  additionalProperties: false,
};

// Ask Opus to propose an improved CALIBRATION EXAMPLES block. The prompt bakes in
// the anti-collapse rules (preserve the poles, keep/widen the spread, correct the
// residuals rather than the consensus); the caller still A/B-evals + gates the
// result, so this is defense in depth, not blind trust.
export async function proposeCalibration({ currentCalibration, resume, signal }) {
  const system =
    "You are a calibration engineer tuning the one-shot CALIBRATION EXAMPLES block that anchors a " +
    "recruiter-style model scoring jobs 0-100 for ONE candidate. Improve the anchors from evidence of where " +
    "the model disagreed with the candidate's real decisions — WITHOUT compressing the score distribution " +
    "toward the middle. Respond with JSON only.";
  const user = `CANDIDATE (résumé):
${(resume || "").slice(0, 3500)}

CURRENT CALIBRATION EXAMPLES:
${currentCalibration}

EVIDENCE — the model's residual errors vs. the candidate's ground-truth actions:
A. APPLIED to, but model UNDER-scored (these deserve HIGH scores, ~80+):
${signal.appliedUnderscored || "  (none)"}
B. REJECTED, but model OVER-scored (these deserve LOWER scores):
${signal.rejectedOverscored || "  (none)"}
C. Largest cheap-vs-strong model disagreements (SECONDARY — model-vs-model, do not over-fit):
${signal.cascade || "  (none)"}

HARD RULES — these exist specifically to stop the calibration collapsing to a flat mean over cycles:
1. PRESERVE THE POLES. Keep at least one anchor scoring >=85 (a near-perfect match — the realistic ceiling; do
   NOT inflate to 95+), at least one <=15 (a clear functional mismatch), and at least one in the 50-55 hard-cap
   band (clearly over-qualified). Never soften these toward the center.
2. WIDEN, DON'T NARROW. Anchor scores must span the full 0-100 range; the standard deviation of your anchors'
   scores must be >= the current set's. Do NOT cluster new anchors near the median.
3. CORRECT RESIDUALS, NOT THE CONSENSUS. Add/adjust anchors that fix the specific disagreements in A and B.
   Do not average toward what the model already does.
4. BOUNDED CHANGE. Keep 6-10 anchors total; modify or add at most 3 per cycle; keep the rest intact.
5. FORMAT: identical to the current block — a header line then "- \\"Title\\" ...context... -> NN." one per
   line, each ending in an explicit integer score.

Return JSON {"calibration":"<full replacement block>","rationale":"<2-4 sentences: what changed, why, and how it preserves/widens spread>"}.`;
  const parsed = await call({
    system, user, maxTokens: 3000, json: true,
    // No temperature/top_p: Opus 4.8 rejects sampling params (400). Exploration
    // comes from the model itself; the eval + manual adoption gate the result.
    schema: PROPOSE_CALIBRATION_SCHEMA, model: "claude-opus-4-8",
  });
  return { calibration: (parsed?.calibration || "").trim(), rationale: (parsed?.rationale || "").trim() };
}

// ---------------------------------------------------------------------------
// 3. Tailor resume + cover letter for one job
// ---------------------------------------------------------------------------
export async function tailorApplication(job, profile) {
  const system =
    "You tailor a candidate's resume and cover letter to a specific job without fabricating experience. Respond with JSON only.";
  const user = `Rewrite the candidate's resume and cover letter to emphasize legitimate overlap with this job. Do NOT invent experience.
Return JSON {"tailored_resume":"...","tailored_cover_letter":"..."} (markdown allowed inside the strings).

BASE RESUME:
${(profile.base_resume_text ?? "").slice(0, 8000)}

BASE COVER LETTER:
${(profile.base_cover_letter_text ?? "").slice(0, 4000)}

JOB: ${job.job_title} @ ${job.company_name}
${(job.job_description_raw ?? "").slice(0, 6000)}`;

  const parsed = await call({ system, user, maxTokens: 8000, json: true, schema: TAILOR_SCHEMA, model: config.ai.models.tailor });
  return {
    tailored_resume: String(parsed?.tailored_resume ?? "").slice(0, 24000),
    tailored_cover_letter: String(parsed?.tailored_cover_letter ?? "").slice(0, 9000),
  };
}

export function aiReady() {
  return Boolean(apiKey);
}
