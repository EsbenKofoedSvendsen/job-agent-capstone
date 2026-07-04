import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

function int(name, fallback) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function num(name, fallback) {
  const v = parseFloat(process.env[name] ?? "");
  return Number.isFinite(v) ? v : fallback;
}

const provider = (process.env.AI_PROVIDER || "anthropic").toLowerCase();

// Base (cheap, high-volume) and strong (quality) model per provider.
const baseModel = process.env.AI_MODEL || (provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5");
const strongModel = provider === "openai" ? "gpt-4o" : "claude-sonnet-4-6";

export const config = {
  port: int("PORT", 5179),

  ai: {
    provider, // "anthropic" | "openai"
    apiKey: process.env.AI_API_KEY || "",
    model: baseModel, // default for any call without an explicit per-task model
    baseUrl:
      process.env.AI_BASE_URL ||
      (provider === "openai"
        ? "https://api.openai.com/v1"
        : "https://api.anthropic.com/v1"),
    // Per-task model knobs. Extraction + first-pass scoring stay cheap (Haiku);
    // tailoring + the confirm-pass use the strong model (Sonnet) by default.
    models: {
      extract: process.env.MODEL_EXTRACT || baseModel,
      score: process.env.MODEL_SCORE || baseModel,
      rescore: process.env.MODEL_RESCORE || strongModel,
      tailor: process.env.MODEL_TAILOR || strongModel,
    },
    // Cascade: any job the first pass scores ABOVE this gets re-scored by the
    // stronger `rescore` model (refines board + email precision). Set the
    // rescore model equal to the score model to disable the second pass.
    rescoreThreshold: int("RESCORE_THRESHOLD", 70),
  },

  scrape: {
    sourceConcurrency: int("SCRAPE_CONCURRENCY", 6),
    pageConcurrency: int("PAGE_CONCURRENCY", 4),
    pageTimeoutMs: int("PAGE_TIMEOUT_MS", 15000),
    scoreBatchSize: int("SCORE_BATCH_SIZE", 10),
    // How many scoring batches to run in parallel. Same token cost, faster wall
    // clock when a scrape produces many new jobs.
    scoreConcurrency: int("SCORE_CONCURRENCY", 4),
  },

  apply: {
    outlookGraphToken: process.env.OUTLOOK_GRAPH_TOKEN || "",
  },

  // Scheduled scraping + email digest (used when hosted always-on).
  digest: {
    // 0 (default) = scheduler off. Set to 4 on the host to scrape every 4h.
    intervalHours: num("SCRAPE_INTERVAL_HOURS", 0),
    // Only email jobs at/above this score.
    minScore: int("DIGEST_MIN_SCORE", 85),
    // Resend (https://resend.com): one API key, sent via fetch (no dependency).
    resendApiKey: process.env.RESEND_API_KEY || "",
    // In Resend test mode, `onboarding@resend.dev` can only email YOUR account
    // address — fine for personal use. Verify a domain later to send anywhere.
    from: process.env.DIGEST_FROM || "Job Agent <onboarding@resend.dev>",
    to: process.env.DIGEST_TO || "",
  },

  // Optional HTTP Basic Auth. STRONGLY recommended when hosting publicly so a
  // stranger with the URL can't trigger actions or wipe your board. Empty = off.
  appPassword: process.env.APP_PASSWORD || "",

  paths: {
    db: path.join(ROOT, "data", "job-agent.db"),
    resumeDir: path.join(ROOT, "storage", "resumes"),
    public: path.join(ROOT, "public"),
  },
};

export function aiConfigured() {
  return Boolean(config.ai.apiKey);
}
