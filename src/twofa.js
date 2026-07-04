// Optional 2FA helper: pulls the most recent 6-digit verification code from a
// Microsoft 365 / Outlook mailbox via the Graph API. Disabled unless
// OUTLOOK_GRAPH_TOKEN is set in .env (a Graph access token with Mail.Read).
import { config } from "./config.js";
import { stripHtml } from "./util.js";

function findCode(text) {
  const hay = text.replace(/\s+/g, " ");
  const near = hay.match(
    /(?:code|verification|verify|otp|one[-\s]?time|passcode|pin|2fa|security)[^0-9]{0,40}(\d{6})/i
  );
  if (near) return near[1];
  const any = hay.match(/(?<!\d)(\d{6})(?!\d)/);
  return any ? any[1] : null;
}

export async function fetchLatestCode({ sinceSeconds = 600, senderDomains = [] } = {}) {
  const token = config.apply.outlookGraphToken;
  if (!token) return { code: null, reason: "OUTLOOK_GRAPH_TOKEN not set." };

  const sinceIso = new Date(Date.now() - sinceSeconds * 1000).toISOString();
  const params = new URLSearchParams({
    $top: "15",
    $orderby: "receivedDateTime desc",
    $select: "subject,from,receivedDateTime,bodyPreview,body",
    $filter: `receivedDateTime ge ${sinceIso}`,
  });

  const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { code: null, reason: `Graph error ${res.status}: ${(await res.text()).slice(0, 160)}` };

  const json = await res.json();
  const domains = senderDomains.map((d) => d.toLowerCase());
  for (const msg of json.value ?? []) {
    const sender = (msg.from?.emailAddress?.address || "").toLowerCase();
    if (domains.length && !domains.some((d) => sender.endsWith(d))) continue;
    const body = msg.body?.contentType?.toLowerCase() === "html" ? stripHtml(msg.body.content || "") : msg.body?.content || msg.bodyPreview || "";
    const code = findCode(`${msg.subject || ""}\n${body}`);
    if (code) return { code, from: sender, subject: msg.subject, received_at: msg.receivedDateTime };
  }
  return { code: null, reason: "No 6-digit code found in recent messages." };
}
