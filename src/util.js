// Run `worker` over `items` with at most `limit` running at once.
// Returns results in the original order. This is the core primitive that lets
// the local app fan out wide (no Cloudflare Worker timeout to fear).
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (e) {
        results[i] = { __error: e instanceof Error ? e.message : String(e) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function tierFor(pct) {
  if (pct >= 85) return "TIER_1";
  if (pct >= 65) return "TIER_2";
  return "TIER_3";
}

export function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&rsquo;|&apos;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function stripHtml(html) {
  return decodeEntities(
    (html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Build a location filter from allowed places (e.g. ["New York"]). Returns null
// when no filter is set. Known cities expand to common synonyms.
export function buildLocationMatcher(terms) {
  const list = (terms ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  if (!list.length) return null;
  const SYN = {
    "new york": ["new york", "nyc", "new york city", "manhattan", "brooklyn"],
    nyc: ["new york", "nyc", "new york city", "manhattan", "brooklyn"],
    "san francisco": ["san francisco", "sf,", "bay area"],
    london: ["london"],
    remote: ["remote", "anywhere", "work from home"],
  };
  // Short abbreviations ("US-NY", "NY or SF") must match as whole tokens —
  // substring matching would false-positive on "Germany" / "Sunnyvale".
  const ABBR = {
    "new york": ["ny"],
    nyc: ["ny"],
    "san francisco": ["sf"],
  };
  const expanded = new Set();
  const abbrs = new Set();
  for (const t of list) {
    (SYN[t] ?? [t]).forEach((x) => expanded.add(x));
    (ABBR[t] ?? []).forEach((x) => abbrs.add(x));
  }
  const allowed = [...expanded];
  const abbrRe = abbrs.size
    ? new RegExp(`(^|[^a-z])(${[...abbrs].join("|")})([^a-z]|$)`, "i")
    : null;
  return (loc) => {
    if (!loc || !loc.trim()) return true; // unknown location -> keep
    const l = loc.toLowerCase();
    return allowed.some((a) => l.includes(a)) || (abbrRe ? abbrRe.test(l) : false);
  };
}
