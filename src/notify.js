// Email digest via Resend (https://resend.com). Uses built-in fetch — no SDK,
// matching the rest of the app. Configure RESEND_API_KEY + DIGEST_TO in .env.
import { config } from "./config.js";

export function digestReady() {
  return Boolean(config.digest.resendApiKey && config.digest.to);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(jobs, minScore) {
  const cards = jobs
    .map((j) => {
      const title = esc(j.job_title);
      const titleHtml = j.job_url
        ? `<a href="${esc(j.job_url)}" style="color:#1a73e8;text-decoration:none">${title}</a>`
        : title;
      return `<div style="border:1px solid #e3e3e3;border-radius:10px;padding:14px 16px;margin:0 0 12px">
  <div style="font-size:16px;font-weight:600;margin-bottom:2px">${titleHtml}</div>
  <div style="color:#555;font-size:14px">${esc(j.company_name)}${j.location ? " · " + esc(j.location) : ""}</div>
  <div style="margin:8px 0 4px"><span style="display:inline-block;background:#e6f4ea;color:#137333;font-weight:600;font-size:13px;padding:2px 8px;border-radius:999px">${Number(j.match_percentage)}% match</span></div>
  <div style="color:#444;font-size:13px;margin-top:6px">${esc(j.match_reasoning)}</div>
</div>`;
    })
    .join("\n");

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto">
  <h2 style="font-size:18px;margin:0 0 4px">${jobs.length} new job match${jobs.length === 1 ? "" : "es"} (${minScore}+)</h2>
  <p style="color:#666;font-size:13px;margin:0 0 16px">From your latest scheduled scrape.</p>
  ${cards}
</div>`;
}

// Send a digest email for the given jobs. Returns {ok} or {ok:false, skipped}.
export async function sendJobDigest(jobs, minScore = config.digest.minScore) {
  if (!digestReady()) return { ok: false, skipped: "digest not configured (RESEND_API_KEY / DIGEST_TO)" };
  if (!jobs || jobs.length === 0) return { ok: false, skipped: "no matching jobs" };

  const subject = `${jobs.length} new job match${jobs.length === 1 ? "" : "es"} (${minScore}+ score)`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.digest.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.digest.from,
      to: [config.digest.to],
      subject,
      html: renderHtml(jobs, minScore),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { ok: true, sent: jobs.length };
}
