// ATS API adapters.
//
// Big employer boards (Greenhouse, Lever, Ashby, Workday, Oracle Recruiting
// Cloud) render listings with JavaScript and serve the real data from JSON
// APIs. Scraping the HTML only ever sees page one. These adapters hit the JSON
// directly, so we get *every* matching posting — fast, complete, no browser.
//
// Geographic filtering happens EARLY: for Workday/Oracle we fetch the cheap
// list (title + location), drop anything outside your locations, and only then
// fetch full descriptions + score. So a 7,000-job tenant with 30 NYC roles
// only costs us 30 detail fetches, not 7,000.
import { mapWithConcurrency, stripHtml, decodeEntities } from "./util.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TIMEOUT = 15000;

// Transient failures (timeouts, 429, 5xx) are common when many large ATS
// payloads (e.g. Greenhouse content=true ~2 MB) are fetched concurrently — a
// single miss otherwise makes a perfectly good source report zero jobs. Retry a
// couple of times with backoff; never retry a real 4xx (not-found, bad token).
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithRetry(doFetch, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(attempt === 1 ? 400 : 1200);
    try {
      const res = await doFetch();
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      lastErr = new Error(`GET ${res.status}`); // retry on retryable status
    } catch (e) {
      lastErr = e; // AbortError (timeout) / network error -> retry
    }
  }
  throw lastErr;
}
const MAX_DETAIL = 50; // cap detail fetches per source (Workday/Oracle)

async function jget(url, headers = {}) {
  const res = await fetchWithRetry(() => fetch(url, {
    headers: { accept: "application/json", "user-agent": UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
  }));
  if (!res.ok) throw new Error(`GET ${res.status} ${url.slice(0, 80)}`);
  return res.json();
}
async function jpost(url, body, headers = {}) {
  const res = await fetchWithRetry(() => fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  }));
  if (!res.ok) throw new Error(`POST ${res.status} ${url.slice(0, 80)}`);
  return res.json();
}

function prettify(token) {
  return String(token || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
function clamp(s, n = 6000) { return String(s || "").slice(0, n); }
function queriesFrom(prefs) {
  return [...(prefs.titles ?? []).slice(0, 3), ...(prefs.keywords ?? []).slice(0, 2)]
    .map((s) => String(s).trim()).filter(Boolean);
}
function parseRelativeDate(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/today|just posted/.test(t)) return new Date().toISOString();
  if (/yesterday/.test(t)) return new Date(Date.now() - 86400000).toISOString();
  const m = t.match(/(\d+)\+?\s*(day|week|month)s?\s*ago/);
  if (m) {
    const n = +m[1], mult = m[2] === "week" ? 7 : m[2] === "month" ? 30 : 1;
    return new Date(Date.now() - n * mult * 86400000).toISOString();
  }
  const d = new Date(text);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
// Apply the location matcher to a list; return {kept, dropped}.
function geoFilter(jobs, locMatch) {
  if (!locMatch) return { kept: jobs, dropped: 0 };
  const kept = jobs.filter((j) => locMatch(j.location));
  return { kept, dropped: jobs.length - kept.length };
}

// ---------------------------------------------------------------------------
// Greenhouse — list endpoint already includes full descriptions.
// ---------------------------------------------------------------------------
const greenhouse = {
  name: "greenhouse",
  async fetch(url, { companyHint, locMatch }) {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const token = segs[0] === "embed" ? (u.searchParams.get("for") || segs[1]) : segs[0];
    if (!token) return { jobs: [], error: "Could not parse Greenhouse board token." };
    const data = await jget(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
    const company = companyHint || prettify(token);
    let jobs = (data.jobs ?? []).map((j) => ({
      job_title: j.title,
      company_name: company,
      location: j.location?.name || "",
      job_description_raw: clamp(stripHtml(decodeEntities(j.content || ""))),
      job_url: j.absolute_url,
      posted_at: j.updated_at || j.first_published || null,
    }));
    const { kept, dropped } = geoFilter(jobs, locMatch);
    return { jobs: kept, pages: 1, dropped_location: dropped };
  },
};

// ---------------------------------------------------------------------------
// Lever
// ---------------------------------------------------------------------------
const lever = {
  name: "lever",
  async fetch(url, { companyHint, locMatch }) {
    const company = new URL(url).pathname.split("/").filter(Boolean)[0];
    if (!company) return { jobs: [], error: "Could not parse Lever company." };
    const data = await jget(`https://api.lever.co/v0/postings/${company}?mode=json`);
    const name = companyHint || prettify(company);
    let jobs = (Array.isArray(data) ? data : []).map((p) => ({
      job_title: p.text,
      company_name: name,
      location: p.categories?.location || "",
      job_description_raw: clamp(p.descriptionPlain || stripHtml(p.description || "")),
      job_url: p.hostedUrl || p.applyUrl,
      posted_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    }));
    const { kept, dropped } = geoFilter(jobs, locMatch);
    return { jobs: kept, pages: 1, dropped_location: dropped };
  },
};

// ---------------------------------------------------------------------------
// Ashby
// ---------------------------------------------------------------------------
const ashby = {
  name: "ashby",
  async fetch(url, { companyHint, locMatch }) {
    const org = new URL(url).pathname.split("/").filter(Boolean)[0];
    if (!org) return { jobs: [], error: "Could not parse Ashby org." };
    const data = await jget(`https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`);
    const name = companyHint || prettify(org);
    let jobs = (data.jobs ?? []).map((j) => ({
      job_title: j.title,
      company_name: name,
      location: j.location || j.address?.postalAddress?.addressLocality || (j.isRemote ? "Remote" : ""),
      job_description_raw: clamp(j.descriptionPlain || stripHtml(j.descriptionHtml || "")),
      job_url: j.jobUrl || j.applyUrl,
      posted_at: j.publishedAt || null,
    }));
    const { kept, dropped } = geoFilter(jobs, locMatch);
    return { jobs: kept, pages: 1, dropped_location: dropped };
  },
};

// ---------------------------------------------------------------------------
// Workday — list (cheap) then bounded detail fetch for descriptions.
// ---------------------------------------------------------------------------
const workday = {
  name: "workday",
  async fetch(url, { prefs, companyHint, locMatch }) {
    const u = new URL(url);
    const host = u.host; // e.g. wellsfargo.wd5.myworkdayjobs.com
    const tenant = host.split(".")[0];
    let site;
    const cxs = u.pathname.match(/\/wday\/cxs\/[^/]+\/([^/]+)/);
    if (cxs) site = cxs[1];
    else {
      const segs = u.pathname.split("/").filter(Boolean).filter((s) => !/^[a-z]{2}(-[A-Z]{2})?$/.test(s));
      site = segs[segs.length - 1];
    }
    if (!site) return { jobs: [], error: "Could not parse Workday site." };
    const base = `https://${host}/wday/cxs/${tenant}/${site}`;
    const company = companyHint || prettify(tenant);

    // 1) gather list rows across preference queries (run queries in parallel)
    const queries = queriesFrom(prefs);
    const byPath = new Map();
    let pages = 0;
    const lists = await mapWithConcurrency(queries.length ? queries : [""], 4, async (q) => {
      try {
        const data = await jpost(`${base}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: q });
        return data.jobPostings ?? [];
      } catch { return null; }
    });
    for (const postings of lists) {
      if (!postings) continue; // query failed
      pages++;
      for (const p of postings) {
        if (!byPath.has(p.externalPath)) {
          byPath.set(p.externalPath, {
            job_title: p.title,
            company_name: company,
            location: p.locationsText || "",
            job_url: `https://${host}${p.externalPath}`,
            posted_at: parseRelativeDate(p.postedOn),
            posted_at_raw: p.postedOn || null,
            _path: p.externalPath,
          });
        }
      }
    }
    if (byPath.size === 0) return { jobs: [], pages, error: "Workday API returned no postings." };

    // 2) EARLY geographic filter (before fetching descriptions)
    const { kept, dropped } = geoFilter([...byPath.values()], locMatch);
    const slice = kept.slice(0, MAX_DETAIL);

    // 3) detail fetch only for survivors
    await mapWithConcurrency(slice, 5, async (job) => {
      try {
        const d = await jget(`${base}${job._path}`);
        const info = d.jobPostingInfo || {};
        job.job_description_raw = clamp(stripHtml(info.jobDescription || ""));
        if (info.startDate) job.posted_at = parseRelativeDate(info.startDate) || job.posted_at;
        if (info.location) job.location = info.location;
      } catch {
        job.job_description_raw = clamp(`${job.job_title} at ${job.company_name}. Location: ${job.location}.`);
      }
      delete job._path;
    });
    return { jobs: slice, pages, dropped_location: dropped,
      note: kept.length > slice.length ? `Capped at ${MAX_DETAIL} of ${kept.length} location matches.` : undefined };
  },
};

// ---------------------------------------------------------------------------
// Oracle Recruiting Cloud (fa.oraclecloud.com)
// ---------------------------------------------------------------------------
const oracle = {
  name: "oracle",
  async fetch(url, { prefs, companyHint, locMatch }) {
    const u = new URL(url);
    const host = u.host;
    const siteM = u.pathname.match(/\/sites\/([^/]+)/);
    const site = siteM ? siteM[1] : (u.searchParams.get("siteNumber") || "");
    if (!site) return { jobs: [], error: "Could not parse Oracle site number." };
    const base = `https://${host}/hcmRestApi/resources/latest`;
    const company = companyHint || prettify(host.split(".")[0]);

    const queries = queriesFrom(prefs);
    const byId = new Map();
    let pages = 0;
    const lists = await mapWithConcurrency(queries.length ? queries : [""], 4, async (q) => {
      const finder = `findReqs;siteNumber=${site},limit=50,sortBy=POSTING_DATES_DESC` + (q ? `,keyword=${encodeURIComponent(q)}` : "");
      try {
        const data = await jget(`${base}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`);
        return data.items?.[0]?.requisitionList ?? [];
      } catch { return null; }
    });
    for (const list of lists) {
      if (!list) continue; // query failed
      pages++;
      for (const r of list) {
        if (!byId.has(r.Id)) {
          byId.set(r.Id, {
            job_title: r.Title,
            company_name: company,
            location: r.PrimaryLocation || "",
            job_url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
            posted_at: r.PostedDate ? parseRelativeDate(r.PostedDate) : null,
            _id: r.Id,
          });
        }
      }
    }
    if (byId.size === 0) return { jobs: [], pages, error: "Oracle API returned no requisitions." };

    const { kept, dropped } = geoFilter([...byId.values()], locMatch);
    const slice = kept.slice(0, MAX_DETAIL);

    await mapWithConcurrency(slice, 5, async (job) => {
      try {
        const d = await jget(`${base}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${job._id}%22,siteNumber=${site}`);
        const item = d.items?.[0] || {};
        const desc = `${item.ExternalDescriptionStr || ""}\n${item.ExternalQualificationsStr || ""}`;
        job.job_description_raw = clamp(stripHtml(desc)) || `${job.job_title} at ${job.company_name}. Location: ${job.location}.`;
      } catch {
        job.job_description_raw = clamp(`${job.job_title} at ${job.company_name}. Location: ${job.location}.`);
      }
      delete job._id;
    });
    return { jobs: slice, pages, dropped_location: dropped,
      note: kept.length > slice.length ? `Capped at ${MAX_DETAIL} of ${kept.length} location matches.` : undefined };
  },
};

// ---------------------------------------------------------------------------
// Amazon (amazon.jobs) — public search.json, descriptions inline.
// ---------------------------------------------------------------------------
const amazon = {
  name: "amazon",
  async fetch(url, { prefs, companyHint, locMatch }) {
    const queries = queriesFrom(prefs);
    const byId = new Map();
    let pages = 0;
    const lists = await mapWithConcurrency(queries.length ? queries : [""], 4, async (q) => {
      try {
        const data = await jget(`https://www.amazon.jobs/en/search.json?result_limit=100&sort=recent&base_query=${encodeURIComponent(q)}`);
        return data.jobs ?? [];
      } catch { return null; }
    });
    for (const jobs of lists) {
      if (!jobs) continue;
      pages++;
      for (const j of jobs) {
        if (byId.has(j.id)) continue;
        const desc = `${j.description || ""}\n${j.basic_qualifications || ""}\n${j.preferred_qualifications || ""}`;
        byId.set(j.id, {
          job_title: j.title,
          company_name: companyHint || "Amazon",
          location: j.location || [j.city, j.state, j.country_code].filter(Boolean).join(", "),
          job_description_raw: clamp(stripHtml(desc)),
          job_url: j.job_path ? `https://www.amazon.jobs${j.job_path}` : url,
          posted_at: j.posted_date ? parseRelativeDate(j.posted_date) : null,
          posted_at_raw: j.posted_date || null,
        });
      }
    }
    if (byId.size === 0) return { jobs: [], pages, error: "Amazon API returned no postings." };
    const { kept, dropped } = geoFilter([...byId.values()], locMatch);
    return { jobs: kept, pages, dropped_location: dropped };
  },
};

// ---------------------------------------------------------------------------
// Eightfold (explore.jobs.<company>.net, *.eightfold.ai) — e.g. Netflix.
// ---------------------------------------------------------------------------
const eightfold = {
  name: "eightfold",
  async fetch(url, { prefs, companyHint, locMatch }) {
    const host = new URL(url).host;
    const co = host.replace(/^explore\.jobs\./, "").split(".")[0];
    const domain = `${co}.com`;
    const company = companyHint || prettify(co);
    const queries = queriesFrom(prefs);
    const byId = new Map();
    let pages = 0;
    const lists = await mapWithConcurrency(queries.length ? queries : [""], 4, async (q) => {
      try {
        const data = await jget(`https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&query=${encodeURIComponent(q)}&start=0&num=100&sort_by=relevance`);
        return data.positions ?? [];
      } catch { return null; }
    });
    for (const positions of lists) {
      if (!positions) continue;
      pages++;
      for (const p of positions) {
        const id = p.id ?? p.display_job_id;
        if (byId.has(id)) continue;
        byId.set(id, {
          job_title: p.name,
          company_name: company,
          location: p.location || p.locations?.[0] || "",
          job_description_raw: clamp(stripHtml(p.job_description || "")) ||
            `${p.name}. ${p.department || ""} ${p.business_unit || ""}. Location: ${p.location || ""}.`,
          job_url: p.canonicalPositionUrl || url,
          posted_at: p.t_create ? new Date(p.t_create * 1000).toISOString() : null,
        });
      }
    }
    if (byId.size === 0) return { jobs: [], pages, error: "Eightfold API returned no positions." };
    const { kept, dropped } = geoFilter([...byId.values()], locMatch);
    return { jobs: kept, pages, dropped_location: dropped };
  },
};

// ---------------------------------------------------------------------------
// SmartRecruiters — list (cheap) then bounded detail fetch for descriptions.
// ---------------------------------------------------------------------------
const smartrecruiters = {
  name: "smartrecruiters",
  async fetch(url, { companyHint, locMatch }) {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const company = segs.find((s) => !/^(v1|companies|postings)$/i.test(s));
    if (!company) return { jobs: [], error: "Could not parse SmartRecruiters company." };
    const api = `https://api.smartrecruiters.com/v1/companies/${company}/postings`;
    let data;
    try { data = await jget(`${api}?limit=100&offset=0`); }
    catch (e) { return { jobs: [], error: `SmartRecruiters API: ${e.message}` }; }
    const name = companyHint || prettify(company);
    let jobs = (data.content ?? []).map((p) => ({
      job_title: p.name,
      company_name: name,
      location: [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(", "),
      job_url: `https://jobs.smartrecruiters.com/${company}/${p.id}`,
      posted_at: p.releasedDate || null,
      _id: p.id,
    }));
    if (jobs.length === 0) return { jobs: [], pages: 1, error: "SmartRecruiters returned no postings." };
    const { kept, dropped } = geoFilter(jobs, locMatch);
    const slice = kept.slice(0, MAX_DETAIL);
    await mapWithConcurrency(slice, 5, async (job) => {
      try {
        const d = await jget(`${api}/${job._id}`);
        const s = d.jobAd?.sections || {};
        const desc = [s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text].filter(Boolean).join("\n");
        job.job_description_raw = clamp(stripHtml(desc)) || `${job.job_title} at ${job.company_name}. Location: ${job.location}.`;
      } catch {
        job.job_description_raw = clamp(`${job.job_title} at ${job.company_name}. Location: ${job.location}.`);
      }
      delete job._id;
    });
    return { jobs: slice, pages: 1, dropped_location: dropped,
      note: kept.length > slice.length ? `Capped at ${MAX_DETAIL} of ${kept.length} location matches.` : undefined };
  },
};

// ---------------------------------------------------------------------------
// Uber — custom careers backend. The public site posts to loadSearchJobsResults
// (accepts a placeholder CSRF token). Location is filtered server-side; we also
// run geoFilter as a backstop. Replaces the old wrong student-iCIMS board.
// ---------------------------------------------------------------------------
const uber = {
  name: "uber",
  async fetch(url, { prefs, companyHint, locMatch }) {
    const queries = queriesFrom(prefs);
    const byId = new Map();
    let pages = 0;
    const lists = await mapWithConcurrency(queries.length ? queries : [""], 4, async (q) => {
      try {
        const data = await jpost(
          "https://www.uber.com/api/loadSearchJobsResults?localeCode=en",
          { params: { query: q, location: [{ country: "USA", region: "New York", city: "New York" }] }, page: 0, limit: 100 },
          { "x-csrf-token": "x" }
        );
        return (data.data && data.data.results) || data.results || [];
      } catch { return null; }
    });
    for (const jobs of lists) {
      if (!jobs) continue;
      pages++;
      for (const j of jobs) {
        if (byId.has(j.id)) continue;
        const loc = j.location || {};
        byId.set(j.id, {
          job_title: j.title,
          company_name: companyHint || "Uber",
          location: [loc.city, loc.region, loc.countryName].filter(Boolean).join(", "),
          job_description_raw: clamp(stripHtml(j.description || "")),
          job_url: `https://www.uber.com/global/en/careers/list/${j.id}/`,
          posted_at: j.updatedDate || j.creationDate || null,
        });
      }
    }
    if (byId.size === 0) return { jobs: [], pages, error: "Uber API returned no postings." };
    const { kept, dropped } = geoFilter([...byId.values()], locMatch);
    return { jobs: kept, pages, dropped_location: dropped };
  },
};

// ---------------------------------------------------------------------------
export function getAdapter(url) {
  let host;
  try { host = new URL(url).host; } catch { return null; }
  if (/greenhouse\.io$/.test(host)) return greenhouse;
  if (/lever\.co$/.test(host)) return lever;
  if (/ashbyhq\.com$/.test(host)) return ashby;
  if (/myworkdayjobs\.com$/.test(host)) return workday;
  if (/oraclecloud\.com$/.test(host)) return oracle;
  if (/amazon\.jobs$/.test(host)) return amazon;
  if (/smartrecruiters\.com$/.test(host)) return smartrecruiters;
  if (/^explore\.jobs\./.test(host) || /eightfold\.ai$/.test(host)) return eightfold;
  if (/(^|\.)uber\.com$/.test(host)) return uber;
  return null;
}
