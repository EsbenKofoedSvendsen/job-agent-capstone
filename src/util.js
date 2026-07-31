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
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
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

// Extract an annual base-salary range from free posting text (pay-transparency
// laws mean most NYC/CA postings state one in the body). Deterministic, no AI.
// Handles ranges ($150,000-$200,000 / $150K-$200K / "150,000 to 200,000") and
// single values, normalizes &mdash;/&ndash; entities, decimals, and USD$/US$
// prefixes. Guards on plausible annual magnitude ($30k-$1M) and requires a $
// sign so it never catches employee counts, funding, or 401(k) figures.
// Returns { min, max } (equal when a single value), or null.
export function parseSalary(text) {
  if (!text) return null;
  const t = String(text)
    .replace(/&mdash;|&ndash;|&#8212;|&#8211;|–|—/g, "-")
    .replace(/&nbsp;/g, " ")
    .replace(/US\$|USD\s?\$?|\$USD/gi, "$");
  const num = (s, k) => {
    let n = parseFloat(String(s).replace(/,/g, ""));
    if (k) n *= 1000;
    return n;
  };
  const R = /\$\s*(\d{2,3}(?:,\d{3})?)(?:\.\d{2})?\s*([kK])?\s*(?:-|to)\s*\$?\s*(\d{2,3}(?:,\d{3})?)(?:\.\d{2})?\s*([kK])?/;
  const m = t.match(R);
  if (m) {
    const lo = num(m[1], m[2]);
    const hi = num(m[3], m[4]);
    if (lo >= 30000 && hi <= 1000000 && hi >= lo) return { min: lo, max: hi };
  }
  const S = /\$\s*(\d{2,3}(?:,\d{3})?)(?:\.\d{2})?\s*([kK])?\b/g;
  let x, best = null;
  while ((x = S.exec(t))) {
    const n = num(x[1], x[2]);
    if (n >= 40000 && n <= 1000000) best = best ? Math.max(best, n) : n;
  }
  return best ? { min: best, max: best } : null;
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
