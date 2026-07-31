// ---------------------------------------------------------------------------
// Job Agent Local — front-end (vanilla JS, no build step)
// ---------------------------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = { jobs: [], profile: null, lastReports: null, scraping: false,
  status: null, nextRunAt: null, errors: [], schedule: null, rescore: null, rescoreBucket: null,
  companyQuery: "", salaryOpen: null,
  filters: { location: "", companies: [], posted: "", scraped: "", minScore: "", sort: "score", hideActioned: true } };

// --- tiny helpers ----------------------------------------------------------
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const splitList = (s) => String(s || "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
// Apply URLs come from scraped third-party pages. esc() stops attribute
// breakout but not the scheme, so a "javascript:" URL would still render as a
// clickable link. Only http(s) is allowed to become an href.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : "");

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function fmtSalary(j) {
  if (j.salary_raw) return j.salary_raw;
  const cur = j.salary_currency || "";
  const f = (n) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
  let range = "";
  if (j.salary_min != null && j.salary_max != null) range = `${f(j.salary_min)} – ${f(j.salary_max)}`;
  else if (j.salary_min != null) range = `${f(j.salary_min)}+`;
  else if (j.salary_max != null) range = `up to ${f(j.salary_max)}`;
  else return "";
  return `${cur} ${range}${j.salary_period ? " / " + j.salary_period : ""}`.trim();
}

// --- toasts ----------------------------------------------------------------
function toast(msg, kind = "", opts = {}) {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.innerHTML = esc(msg);
  if (opts.action) {
    const a = document.createElement("span");
    a.className = "t-act"; a.textContent = opts.action.label;
    a.onclick = () => { opts.action.onClick(); t.remove(); };
    t.appendChild(a);
  }
  $("#toasts").appendChild(t);
  if (!opts.sticky) setTimeout(() => t.remove(), opts.duration || 4500);
  return t;
}

// --- health ----------------------------------------------------------------
async function loadHealth() {
  try {
    const h = await api("GET", "/api/health");
    const pill = $("#ai-pill");
    if (h.ai_ready) { pill.className = "pill pill-ok"; pill.textContent = `AI: ${h.provider}`; }
    else { pill.className = "pill pill-bad"; pill.textContent = "AI key missing"; }
  } catch { /* ignore */ }
}

// --- scrape status + countdown ---------------------------------------------
function fmtCountdown(ms) {
  if (ms == null) return "—";
  if (ms <= 0) return "due now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
async function loadStatus() {
  try { state.status = await api("GET", "/api/status"); applyRole(); renderStatus(); } catch { /* ignore */ }
}
// Read-only demo accounts: hide every control that acts (the server enforces
// this too — hiding is just so judges don't click into 403s).
function applyRole() {
  state.role = state.status?.role || "admin";
  if (state.role !== "viewer") return;
  ["btn-scrape", "btn-clear", "btn-settings", "btn-rescore"].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.classList.add("hidden");
  });
}
function renderStatus() {
  const el = $("#scrape-status"); if (!el) return;
  const s = state.status; if (!s) { el.innerHTML = ""; return; }
  const auto = s.last_scrape_auto?.at ? timeAgo(s.last_scrape_auto.at) : "never";
  const man = s.last_scrape_manual?.at ? timeAgo(s.last_scrape_manual.at) : "never";
  const sc = s.scheduler || {};
  state.nextRunAt = sc.nextRunAt || null;
  const sched = sc.enabled
    ? `Next auto scrape in <b id="ss-countdown">${fmtCountdown(state.nextRunAt ? state.nextRunAt - Date.now() : null)}</b> <span class="ss-muted">(${(sc.times || []).join(", ") || "no times set"})</span>`
    : `Auto scrape <b>off</b>`;
  const dayShort = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };
  const skip = (sc.skipDays || []).slice().sort().map((d) => dayShort[d]).join(", ");
  const digest = s.digest_ready
    ? `Email digest ≥ ${s.digest_min_score} <span class="ss-ok">on</span>`
    : `Email digest <span class="ss-bad">not configured</span>`;
  el.innerHTML =
    `<span class="ss-item">Last auto scrape: <b>${auto}</b></span>` +
    `<span class="ss-item">Last manual scrape: <b>${man}</b></span>` +
    `<span class="ss-item">${sched}</span>` +
    (skip ? `<span class="ss-item ss-muted">Paused: ${skip}</span>` : "") +
    `<span class="ss-item ss-muted">${digest}</span>`;
}
function tickCountdown() {
  const el = $("#ss-countdown"); if (!el || !state.nextRunAt) return;
  const left = state.nextRunAt - Date.now();
  el.textContent = fmtCountdown(left);
  // Just after a scheduled run is due, refresh status + board to pick it up.
  if (left < -3000 && !state._refreshingAfterDue) {
    state._refreshingAfterDue = true;
    setTimeout(() => { loadStatus(); loadJobs(); state._refreshingAfterDue = false; }, 4000);
  }
}

// --- jobs / board ----------------------------------------------------------
async function loadJobs() {
  state.jobs = await api("GET", "/api/jobs");
  render();
  renderSalaryInsights();
}

// Market-value card: base-salary ranges of board jobs, bucketed by match level.
// Interactive market-value card: user sets a match-score window, sees the
// salary distribution of board jobs in it. Computed client-side from the jobs
// already loaded (each carries salary_min/max + match_percentage).
function renderSalaryInsights() {
  const card = $("#salary-card");
  if (!card) return;
  const priced = state.jobs.filter((x) => x.status !== "REJECTED" && x.salary_min != null && x.salary_max != null);
  const totalNonRej = state.jobs.filter((x) => x.status !== "REJECTED").length;
  if (!priced.length) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const clamp = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : d; };
  const lo = clamp($("#salary-min")?.value, 70);
  let hi = clamp($("#salary-max")?.value, 100);
  if (hi < lo) hi = lo;
  $("#salary-cov").textContent = `· ${priced.length} of ${totalNonRej} board jobs have a stated range`;
  const inRange = priced
    .filter((x) => { const m = x.match_percentage || 0; return m >= lo && m <= hi; })
    .map((x) => ({ ...x, mid: (x.salary_min + x.salary_max) / 2 }))
    .sort((a, b) => b.mid - a.mid);
  const k = (n) => (n == null ? "—" : "$" + Math.round(n / 1000) + "k");
  const pctOf = (vals, p) => { if (!vals.length) return null; const s = [...vals].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
  if (!inRange.length) { $("#salary-rows").innerHTML = `<p class="hint">No priced jobs in the ${lo}–${hi} match window.</p>`; return; }
  const mid = pctOf(inRange.map((x) => x.mid), 0.5);
  const p25 = pctOf(inRange.map((x) => x.mid), 0.25);
  const p75 = pctOf(inRange.map((x) => x.mid), 0.75);
  const bandLo = pctOf(inRange.map((x) => x.salary_min), 0.5);
  const bandHi = pctOf(inRange.map((x) => x.salary_max), 0.5);
  const open = !!state.salaryOpen;
  const list = open
    ? `<div style="margin:6px 0 4px 4px; border-left:2px solid var(--border,#e2e8f0); padding-left:12px">` +
      inRange.map((x) =>
        `<div class="kv" style="gap:8px"><span style="width:44px" class="hint">${x.match_percentage}%</span>` +
        `<span>${k(x.salary_min)}–${k(x.salary_max)} <span class="hint">· ${esc(x.company_name)} — ${esc((x.job_title || "").slice(0, 48))}</span></span></div>`
      ).join("") + `</div>`
    : "";
  $("#salary-rows").innerHTML =
    `<div id="salary-headline" style="cursor:pointer; padding:2px 0" title="Click to see the ${inRange.length} jobs">
       <b style="font-size:18px">${k(mid)}</b> midpoint
       <span class="hint">· ${k(p25)}–${k(p75)} typical · band ${k(bandLo)}–${k(bandHi)} · n=${inRange.length} at ${lo}–${hi}% match · ${open ? "▾ hide" : "▸ show"} jobs</span>
     </div>${list}`;
  const h = $("#salary-headline");
  if (h) h.onclick = () => { state.salaryOpen = !state.salaryOpen; renderSalaryInsights(); };
}
function render() {
  const j = state.jobs;
  const weekAgo = Date.now() - 7 * 86400000;
  const applied = j.filter((x) => x.applied_at && new Date(x.applied_at) > weekAgo).length;
  const pending = j.filter((x) => ["PENDING_APPROVAL", "SCRAPED", "TAILORED"].includes(x.status)).length;
  const avg = j.length ? Math.round(j.reduce((a, x) => a + x.match_percentage, 0) / j.length) : 0;
  $("#metrics").innerHTML = [
    ["Total processed", j.length],
    ["Applied this week", applied],
    ["Open / pending", pending],
    ["Avg match", avg + "%"],
  ].map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

  syncCompanyOptions(j);
  const filtered = sortJobs(applyFilters(j));
  for (const [tier, col, cnt] of [["TIER_1", "#col-1", "#count-1"], ["TIER_2", "#col-2", "#count-2"], ["TIER_3", "#col-3", "#count-3"]]) {
    const items = filtered.filter((x) => x.tier === tier);
    $(cnt).textContent = items.length;
    $(col).innerHTML = items.length
      ? items.map(card).join("")
      : `<p class="empty">No jobs match.</p>`;
  }
  $$(".card").forEach((c) => (c.onclick = () => openDrawer(c.dataset.id)));
  const anyFilter = state.filters.location || state.filters.companies.length || state.filters.posted || state.filters.scraped || state.filters.minScore;
  $("#filter-count").textContent = anyFilter ? `Showing ${filtered.length} of ${j.length}` : `${j.length} jobs`;
}

// Keep the company multi-select in sync with whatever companies are on the
// board, preserving current selections. Checkboxes so several companies can
// be active at once; a search box because the board spans ~90 companies.
function syncCompanyOptions(jobs) {
  const list = $("#company-list");
  if (!list) return;
  const counts = new Map();
  for (const x of jobs) if (x.company_name) counts.set(x.company_name, (counts.get(x.company_name) || 0) + 1);
  state.filters.companies = state.filters.companies.filter((c) => counts.has(c));
  const q = (state.companyQuery || "").trim().toLowerCase();
  const companies = [...counts.keys()].sort((a, b) => a.localeCompare(b))
    .filter((c) => !q || c.toLowerCase().includes(q));
  list.innerHTML = companies.map((c) =>
    `<label class="dd-item"><input type="checkbox" data-company="${esc(c)}"${state.filters.companies.includes(c) ? " checked" : ""}/><span>${esc(c)}</span><span class="dd-count">${counts.get(c)}</span></label>`
  ).join("") || `<div class="hint" style="padding:6px">No matching companies</div>`;
  list.querySelectorAll("input[data-company]").forEach((cb) => {
    cb.onchange = () => {
      const set = new Set(state.filters.companies);
      cb.checked ? set.add(cb.dataset.company) : set.delete(cb.dataset.company);
      state.filters.companies = [...set];
      render();
    };
  });
  updateCompanyButton();
}
function updateCompanyButton() {
  const btn = $("#filter-company-btn");
  if (!btn) return;
  const sel = state.filters.companies;
  btn.textContent = sel.length === 0 ? "All companies ▾"
    : sel.length === 1 ? `${sel[0]} ▾`
    : `${sel.length} companies ▾`;
}

// Epoch ms for a field, 0 when missing/invalid.
function tsOf(iso) {
  const n = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
}
// Date key (posted_at, falling back to scraped_at) for tie-breaks / "newest".
function dateKey(x) { return tsOf(x.posted_at || x.scraped_at); }
// Sort jobs by the chosen order:
//   score         = highest match first (relevancy), tie-broken by newest
//   newest        = most recently posted first (backend's default order)
//   scraped       = most recently scraped first
//   scraped_score = most recent scrape day first, then highest match within it
//                   ("latest scrape" and "best match" applied simultaneously)
function sortJobs(jobs) {
  const arr = jobs.slice();
  const sort = state.filters.sort || "score";
  if (sort === "score") {
    arr.sort((a, b) => (b.match_percentage - a.match_percentage) || (dateKey(b) - dateKey(a)));
  } else if (sort === "scraped") {
    arr.sort((a, b) => tsOf(b.scraped_at) - tsOf(a.scraped_at));
  } else if (sort === "scraped_score") {
    const day = (x) => String(x.scraped_at || "").slice(0, 10); // YYYY-MM-DD bucket = one scrape day
    arr.sort((a, b) =>
      day(b).localeCompare(day(a)) ||
      (b.match_percentage - a.match_percentage) ||
      (dateKey(b) - dateKey(a)));
  }
  return arr;
}

function applyFilters(jobs) {
  const f = state.filters;
  const loc = f.location.trim().toLowerCase();
  const days = parseInt(f.posted, 10);
  const cutoff = Number.isFinite(days) ? Date.now() - days * 86400000 : null;
  const scrapedDays = parseInt(f.scraped, 10);
  const scrapedCutoff = Number.isFinite(scrapedDays) ? Date.now() - scrapedDays * 86400000 : null;
  const minScore = parseInt(f.minScore, 10);
  return jobs.filter((x) => {
    if (f.hideActioned && (x.status === "APPLIED" || x.status === "REJECTED")) return false;
    if (loc && !(x.location || "").toLowerCase().includes(loc)) return false;
    if (f.companies.length && !f.companies.includes(x.company_name)) return false;
    if (cutoff) {
      const d = x.posted_at || x.scraped_at;
      if (!d || new Date(d).getTime() < cutoff) return false;
    }
    if (scrapedCutoff) {
      if (!x.scraped_at || new Date(x.scraped_at).getTime() < scrapedCutoff) return false;
    }
    if (Number.isFinite(minScore) && (x.match_percentage ?? 0) < minScore) return false;
    return true;
  });
}
function ring(pct) {
  const r = 16, c = 2 * Math.PI * r, off = c - (c * pct) / 100;
  const color = pct >= 85 ? "var(--tier1)" : pct >= 65 ? "var(--tier2)" : "var(--tier3)";
  return `<div class="ring"><svg width="40" height="40">
    <circle cx="20" cy="20" r="${r}" stroke="var(--border)" stroke-width="3" fill="none"/>
    <circle cx="20" cy="20" r="${r}" stroke="${color}" stroke-width="3" fill="none"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" stroke-linecap="round"/></svg>
    <div class="n" style="color:${color}">${pct}</div></div>`;
}
function card(j) {
  const posted = j.posted_at ? `Posted ${timeAgo(j.posted_at)}`
    : (j.posted_at_raw ? `Posted ${esc(j.posted_at_raw)}` : "");
  const scraped = j.scraped_at ? `Scraped ${timeAgo(j.scraped_at)}` : "";
  return `<div class="card" data-id="${j.id}">
    <div class="top">
      <div>
        <div class="title">${esc(j.job_title)}</div>
        <div class="sub">${esc(j.company_name)}${j.location ? " · " + esc(j.location) : ""}</div>
      </div>${ring(j.match_percentage)}
    </div>
    <div class="meta"><span class="badge st-${j.status}">${esc(j.status.replace(/_/g, " "))}</span>${posted ? `<span>${posted}</span>` : ""}${scraped ? `<span class="ss-muted">${scraped}</span>` : ""}</div>
  </div>`;
}

// --- drawer ----------------------------------------------------------------
async function openDrawer(id) {
  const { job, log, rescore } = await api("GET", `/api/jobs/${id}`);
  const terminal = ["APPLIED", "REJECTED"].includes(job.status);

  // Cascade re-score effect: what the fast first pass scored vs. what the stronger
  // confirm pass changed it to. Only present for jobs that cleared the threshold.
  let rescoreHtml = "";
  if (rescore) {
    const d = rescore.delta;
    const cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const sign = d > 0 ? "+" : "";
    rescoreHtml = `<div class="rescore-effect">
      <div class="re-head">
        <span class="re-label">Confirm-pass re-score</span>
        <span class="re-move">${rescore.first_score}% <span class="re-arrow">→</span> ${rescore.final_score}%
          <span class="re-delta ${cls}">${d === 0 ? "no change" : sign + d}</span></span>
      </div>
      ${rescore.first_reasoning ? `<div class="re-row"><span class="re-k">Fast pass</span><div>${esc(rescore.first_reasoning)}</div></div>` : ""}
      ${rescore.final_reasoning ? `<div class="re-row"><span class="re-k">Confirm pass</span><div>${esc(rescore.final_reasoning)}</div></div>` : ""}
    </div>`;
  }
  const hasTailored = job.tailored_resume_text || job.tailored_cover_letter_text;

  const details = [];
  if (fmtSalary(job)) details.push(["Salary", esc(fmtSalary(job))]);
  if (job.posted_at || job.posted_at_raw) details.push(["Posted", esc(job.posted_at ? timeAgo(job.posted_at) : job.posted_at_raw)]);
  if (job.scraped_at) details.push(["Scraped", `${esc(timeAgo(job.scraped_at))} <span class="hint">(${esc(new Date(job.scraped_at).toLocaleString())})</span>`]);
  const applyUrl = safeUrl(job.job_url);
  if (job.job_url) details.push(["Apply", applyUrl
    ? `<a class="link" href="${esc(applyUrl)}" target="_blank" rel="noopener">${esc(applyUrl)}</a>`
    : `<span class="hint">${esc(job.job_url)}</span>`]);

  let actions = "";
  if (terminal) {
    actions = `<button class="btn" data-act="reopen">↺ Reopen</button>
               <button class="btn btn-danger" data-act="delete">Delete</button>`;
  } else {
    actions = `<button class="btn" data-act="tailor">${hasTailored ? "↻ Re-tailor" : "✦ Tailor"}</button>
      ${applyUrl ? `<a class="btn" href="${esc(applyUrl)}" target="_blank" rel="noopener">↗ Open apply page</a>` : ""}
      <button class="btn" data-act="markapplied">✓ Mark applied</button>
      <button class="btn btn-danger" data-act="reject">✕ Reject</button>`;
  }

  $("#drawer-panel").innerHTML = `
    <h2>${esc(job.job_title)}</h2>
    <div class="d-sub">${esc(job.company_name)}${job.location ? " · " + esc(job.location) : ""}</div>
    ${details.length ? `<div class="section panelbox">
      <h4>Posting details</h4>${details.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span>${v}</span></div>`).join("")}
    </div>` : ""}
    <div class="section panelbox">
      <h4>AI match · ${job.match_percentage}%</h4>
      <div>${esc(job.match_reasoning) || "—"}</div>
      ${rescoreHtml}
    </div>
    ${state.role === "viewer" ? "" : `<div class="drawer-actions">${actions}</div>`}
    ${hasTailored ? `<div class="section"><h4>Tailored resume</h4><div class="panelbox"><pre>${esc(job.tailored_resume_text || "")}</pre></div></div>
      <div class="section"><h4>Tailored cover letter</h4><div class="panelbox"><pre>${esc(job.tailored_cover_letter_text || "")}</pre></div></div>` : ""}
    <div class="section"><h4>Status history</h4>
      ${log.map((e) => `<div class="kv"><span class="k">${timeAgo(e.created_at)}</span><span>${esc(e.from_status || "—")} → ${esc(e.to_status)}</span></div>`).join("") || '<span class="hint">No history.</span>'}
    </div>
    <div class="section"><h4>Description</h4><div class="panelbox"><pre>${esc(job.job_description_raw)}</pre></div></div>`;

  $$("#drawer-panel [data-act]").forEach((b) => (b.onclick = () => drawerAction(b.dataset.act, job)));
  $("#drawer").classList.remove("hidden");
}
function closeDrawer() { $("#drawer").classList.add("hidden"); }

async function drawerAction(act, job) {
  try {
    if (act === "tailor") {
      const t = toast("Tailoring resume & cover letter…", "", { sticky: true });
      await api("POST", `/api/jobs/${job.id}/tailor`);
      t.remove(); toast("Tailored ✓", "ok");
      await loadJobs(); openDrawer(job.id);
    } else if (act === "markapplied") {
      await api("PATCH", `/api/jobs/${job.id}`, {
        status: "APPLIED", applied_at: new Date().toISOString(), statusNote: "Marked as applied manually",
      });
      toast("Marked as applied ✓", "ok"); await loadJobs(); openDrawer(job.id);
    } else if (act === "reject") {
      await api("POST", `/api/jobs/${job.id}/reject`);
      toast("Rejected — feedback recorded", "ok"); await loadJobs(); closeDrawer();
    } else if (act === "reopen") {
      await api("POST", `/api/jobs/${job.id}/reopen`);
      toast("Reopened", "ok"); await loadJobs(); openDrawer(job.id);
    } else if (act === "delete") {
      await api("DELETE", `/api/jobs/${job.id}`);
      toast("Deleted", "ok"); await loadJobs(); closeDrawer();
    }
  } catch (e) { toast(e.message, "err", { duration: 8000 }); }
}

// --- scrape (SSE) ----------------------------------------------------------
function runScrape() {
  if (state.scraping) return;
  state.scraping = true;
  const btn = $("#btn-scrape"); const label = $(".btn-label", btn);
  btn.disabled = true; label.innerHTML = `<span class="spin">⟳</span> Starting…`;
  const reports = [];
  const es = new EventSource("/api/scrape/stream");
  es.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "start") label.textContent = `Scraping 0/${m.total}…`;
    else if (m.type === "progress") { label.textContent = `Scraping ${m.done}/${m.total}…`; loadJobs(); }
    else if (m.type === "scoring") label.innerHTML = `<span class="spin">⟳</span> Scoring ${m.count} jobs…`;
    else if (m.type === "done") {
      state.lastReports = m.reports;
      state.lastDropSamples = m.dropped_location_samples || [];
      state.lastAiUsage = m.ai_usage || null;
      const ok = m.reports.filter((r) => r.scraped).length;
      const failed = m.reports.filter((r) => r.error).length;
      toast(`Scraped ${ok}/${m.reports.length} source(s) · ${m.total_inserted} new job(s)${failed ? ` · ${failed} failed` : ""}`,
        m.total_inserted ? "ok" : "warn", { action: { label: "Details", onClick: showReport }, duration: 9000 });
      $("#btn-report").classList.remove("hidden");
    } else if (m.type === "emailed") toast(`📧 Emailed ${m.count} new match${m.count === 1 ? "" : "es"} (85+)`, "ok", { duration: 8000 });
    else if (m.type === "email_error") toast("Digest email failed: " + m.error, "warn", { duration: 8000 });
    else if (m.type === "error") toast("Scrape error: " + m.error, "err", { duration: 8000 });
    else if (m.type === "end") { es.close(); endScrape(); }
  };
  es.onerror = () => { es.close(); endScrape(); };
  function endScrape() {
    state.scraping = false; btn.disabled = false; label.textContent = "⟳ Scrape now"; loadJobs(); loadStatus();
  }
}
function showReport() {
  const reports = state.lastReports || [];
  const tot = (k) => reports.reduce((a, r) => a + (r[k] || 0), 0);
  $("#report-card").innerHTML = `
    <h2 style="margin-top:0">Scrape report</h2>
    <div class="hint">${reports.length} sources · ${tot("extracted")} extracted · ${tot("inserted")} inserted · ${tot("skipped_duplicates")} duplicates · ${tot("skipped_known_reject")} known-rejects · ${tot("skipped_seniority_gate")} seniority-gated · ${tot("skipped_location")} off-location · ${tot("skipped_title")} title-excluded · ${tot("skipped_irrelevant")} off-target · ${tot("skipped_low_score")} below-min-score${state.lastAiUsage ? ` · <b>est. AI cost $${state.lastAiUsage.cost}</b>` : ""}</div>
    ${reports.map((r) => `<div class="report-row ${r.error ? "err" : r.inserted ? "ok" : ""}">
      <div class="url">${esc(r.label || r.url)}${r.diagnostics?.via ? ` <span class="hint">· ${esc(r.diagnostics.via)}</span>` : ""}</div>
      <div class="stats"><span>scraped: ${r.scraped ? "yes" : "no"}</span><span>pages: ${r.pages_checked || 0}</span>
        <span>extracted: ${r.extracted}</span><span>inserted: ${r.inserted}</span><span>dupes: ${r.skipped_duplicates}</span><span>off-loc: ${r.skipped_location || 0}</span></div>
      ${r.diagnostics?.note ? `<div class="hint">${esc(r.diagnostics.note)}</div>` : ""}
      ${r.error ? `<div class="err-msg">${esc(r.error)}</div>` : ""}</div>`).join("")}
    ${(state.lastDropSamples || []).length ? `<div class="report-row" style="margin-top:10px">
      <div class="url">Sample of location-filtered drops (sanity-check the filter)</div>
      <div class="hint" style="margin-top:4px">${state.lastDropSamples.map((s) => esc(s)).join(" · ")}</div></div>` : ""}
    <div style="margin-top:14px; display:flex; gap:8px">
      <button class="btn btn-primary" id="report-export">⬇ Export JSON</button>
      <button class="btn" id="report-close">Close</button></div>`;
  $("#report-modal").classList.remove("hidden");
  $("#report-close").onclick = () => $("#report-modal").classList.add("hidden");
  $("#report-export").onclick = exportReport;
}
function exportReport() {
  const payload = {
    exported_at: new Date().toISOString(),
    summary: {
      sources: (state.lastReports || []).length,
      extracted: (state.lastReports || []).reduce((a, r) => a + (r.extracted || 0), 0),
      inserted: (state.lastReports || []).reduce((a, r) => a + (r.inserted || 0), 0),
    },
    reports: state.lastReports || [],
    dropped_location_samples: state.lastDropSamples || [],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `scrape-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Scrape JSON downloaded", "ok");
}

// --- settings --------------------------------------------------------------
async function loadSettings() {
  const p = await api("GET", "/api/profile"); state.profile = p;
  $("#f-resume").value = p.base_resume_text || "";
  $("#f-cover").value = p.base_cover_letter_text || "";
  const tp = p.target_preferences || {};
  $("#f-titles").value = (tp.titles || []).join(", ");
  $("#f-keywords").value = (tp.keywords || []).join(", ");
  $("#f-locations").value = (tp.locations || []).join(", ");
  $("#f-locfilter").value = (tp.location_filter || []).join(", ");
  $("#f-excluded").value = (tp.excluded_companies || []).join(", ");
  $("#f-exclude-titles").value = (tp.exclude_title_keywords || []).join(", ");
  $("#f-min-score").value = tp.min_score ? String(tp.min_score) : "";
  let health = {};
  try { health = await api("GET", "/api/sources/health"); } catch { health = {}; }
  state.sourceHealth = health || {};
  renderSources(tp.scrape_sources || []);
  loadSchedule();
  loadScoring();
  loadCalibration();
}

// --- scoring prompts panel -------------------------------------------------
async function loadScoring() {
  try {
    const s = await api("GET", "/api/settings/scoring");
    state.scoringDefaults = { rubric: s.defaultRubric || "", calibration: s.defaultCalibration || "" };
    $("#f-scoring-rubric").value = s.rubric || "";
    $("#f-scoring-calibration").value = s.calibration || "";
  } catch (e) { /* ignore — panel just stays empty */ }
}
async function saveScoring() {
  $("#scoring-status").textContent = "Saving…";
  try {
    const r = await api("PUT", "/api/settings/scoring", {
      rubric: $("#f-scoring-rubric").value,
      calibration: $("#f-scoring-calibration").value,
    });
    $("#f-scoring-rubric").value = r.rubric || "";
    $("#f-scoring-calibration").value = r.calibration || "";
    const allDefault = r.usingDefaultRubric && r.usingDefaultCalibration;
    $("#scoring-status").textContent = allDefault ? "Saved ✓ (using built-in default)" : "Saved ✓";
    toast("Scoring prompts updated", "ok");
    setTimeout(() => ($("#scoring-status").textContent = ""), 3000);
  } catch (e) { $("#scoring-status").textContent = ""; toast(e.message, "err"); }
}

// --- auto-calibration panel ------------------------------------------------
async function loadCalibration() {
  try { renderCalibration(await api("GET", "/api/calibration")); } catch (e) { /* ignore */ }
}
function renderCalibration(data) {
  const el = $("#calib-proposal"); if (!el) return;
  const st = data.status || {}, p = data.proposal;
  const cadence = st.lastRun ? `Last run ${timeAgo(st.lastRun)} · next due in ~${st.daysUntilNext} day(s).` : "Not run yet — next scheduled tick will propose one.";
  if (!p) { el.innerHTML = `<p class="hint">${cadence} No pending proposal.</p>`; return; }
  const e = p.eval || {};
  const gate = e.gatePass ? `<span class="re-delta up">GATE PASS</span>` : `<span class="re-delta down">GATE FAIL</span>`;
  const arrow = (a, b) => `${a} <span class="re-arrow">→</span> ${b}`;
  el.innerHTML = `
    <p class="hint">${cadence}</p>
    <div class="panelbox" style="margin-top:6px">
      <div class="re-head" style="margin-bottom:8px">${gate}
        <span class="hint">proposed ${timeAgo(p.created_at)} · ${esc(p.model || "")}${p.cost != null ? ` · est $${p.cost}` : ""}</span></div>
      <div class="kv"><span class="k">Accuracy</span><span>label error ${arrow(e.labelErrorCurrent, e.labelErrorProposed)} ${e.improvesAccuracy ? "✓ better" : (e.accWithinNoise ? "≈ within noise" : "✗ worse")} <span class="hint">(lower = closer to your apply/reject calls)</span></span></div>
      <div class="kv"><span class="k">Spread</span><span>stdev ${arrow(e.spreadCurrent, e.spreadProposed)} ${e.spreadOk ? "✓" : "✗"} <span class="hint">(floor ${e.spreadFloor} — anti-collapse)</span></span></div>
      <div class="kv"><span class="k">Poles</span><span>${e.polesIntact ? "✓ intact (85+ / ≤15 / hard-cap kept)" : "✗ a pole was lost"}</span></div>
      <div class="kv"><span class="k">Eval set</span><span>${e.nLabeled} labeled + spread sample = ${e.nEval} jobs</span></div>
      ${p.rationale ? `<div style="margin-top:8px"><span class="re-label">Opus rationale</span><div style="margin-top:4px">${esc(p.rationale)}</div></div>` : ""}
      <div style="margin-top:10px"><span class="re-label">Proposed calibration</span>
        <textarea class="mono" rows="12" readonly style="margin-top:4px">${esc(p.proposedCalibration || "")}</textarea></div>
      <div class="row" style="margin-top:10px">
        <button id="btn-calib-adopt" class="btn btn-primary">Adopt proposal</button>
        <button id="btn-calib-dismiss" class="btn btn-danger">Dismiss</button>
        <span class="hint">${e.gatePass ? "Passes the eval gate." : "Below the gate — review carefully before adopting."}</span>
      </div>
    </div>`;
  $("#btn-calib-adopt").onclick = async () => {
    if (!confirm("Adopt these anchors as your live scoring calibration? (You can still edit or reset in Scoring prompts above.)")) return;
    try { await api("POST", "/api/calibration/adopt"); toast("Calibration adopted ✓", "ok"); loadScoring(); loadCalibration(); }
    catch (e2) { toast(e2.message, "err"); }
  };
  $("#btn-calib-dismiss").onclick = async () => {
    try { await api("POST", "/api/calibration/dismiss"); toast("Proposal dismissed", "ok"); loadCalibration(); }
    catch (e2) { toast(e2.message, "err"); }
  };
}

// --- schedule & email settings panel --------------------------------------
const DAY_LABELS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]];
function timeRow(val) {
  return `<div class="time-row"><input type="time" class="sch-time" value="${esc(val || "")}"/><button class="btn small btn-danger sch-time-del" title="Remove">✕</button></div>`;
}
function renderTimes(times) {
  $("#sch-times").innerHTML = (times && times.length ? times : ["09:00"]).map(timeRow).join("");
  $$(".sch-time-del").forEach((b) => (b.onclick = () => b.closest(".time-row").remove()));
}
async function loadSchedule() {
  try {
    const s = await api("GET", "/api/settings/schedule");
    state.schedule = s;
    renderTimes(s.times);
    $("#sch-digest").value = s.digestMinScore;
    $("#sch-rescore").value = s.rescoreThreshold;
    const skip = new Set(s.skipDays || []);
    $("#sch-days").innerHTML = DAY_LABELS.map(([label, d]) =>
      `<label class="day-chip"><input type="checkbox" data-day="${d}"${skip.has(d) ? " checked" : ""}/> ${label}</label>`
    ).join("");
  } catch (e) { /* ignore */ }
}
async function saveSchedule() {
  $("#sched-status").textContent = "Saving…";
  const times = $$("#sch-times .sch-time").map((i) => i.value).filter(Boolean);
  const skipDays = $$("#sch-days input[data-day]").filter((c) => c.checked).map((c) => Number(c.dataset.day));
  try {
    const updated = await api("PUT", "/api/settings/schedule", {
      times,
      digestMinScore: parseInt($("#sch-digest").value, 10),
      rescoreThreshold: parseInt($("#sch-rescore").value, 10),
      skipDays,
    });
    state.schedule = updated;
    renderTimes(updated.times);
    $("#sch-digest").value = updated.digestMinScore;
    $("#sch-rescore").value = updated.rescoreThreshold;
    $("#sched-status").textContent = "Saved ✓";
    toast("Schedule updated", "ok");
    loadStatus();
    setTimeout(() => ($("#sched-status").textContent = ""), 2500);
  } catch (e) { $("#sched-status").textContent = ""; toast(e.message, "err"); }
}
function renderSources(sources) {
  $("#sources-list").innerHTML = sources.map((s, i) => sourceRow(s, i)).join("") || sourceRow({ url: "", label: "" }, 0);
  bindSources();
}
// Status dot from the latest scrape outcome for this source URL.
function sourceStatus(url) {
  const h = (state.sourceHealth || {})[url];
  if (!h) return { cls: "unknown", title: "Not scraped yet" };
  if (h.status === "error") return { cls: "error", title: `Error: ${h.error || "unknown"} · ${timeAgo(h.at)}` };
  if (h.status === "empty") return { cls: "empty", title: `Loaded, 0 jobs · ${timeAgo(h.at)}` };
  return { cls: "ok", title: `${h.jobs} jobs · ${h.inserted} new${h.via ? ` · via ${h.via}` : ""} · ${timeAgo(h.at)}` };
}
function sourceRow(s, i) {
  const st = sourceStatus(s.url);
  return `<div class="source-row" data-i="${i}">
    <span class="src-status ${st.cls}" title="${esc(st.title)}"></span>
    <input type="text" class="src-label" placeholder="Label" value="${esc(s.label || "")}"/>
    <input type="text" class="src-url" placeholder="https://…" value="${esc(s.url || "")}"/>
    <button class="btn small btn-danger src-del">✕</button></div>`;
}
function bindSources() {
  $$(".src-del").forEach((b) => (b.onclick = () => { b.closest(".source-row").remove(); }));
}
function collectSources() {
  return $$("#sources-list .source-row").map((r) => ({
    label: $(".src-label", r).value.trim(), url: $(".src-url", r).value.trim(),
  })).filter((s) => s.url);
}
async function saveSettings() {
  $("#save-status").textContent = "Saving…";
  const tp = { ...(state.profile.target_preferences || {}) };
  tp.titles = splitList($("#f-titles").value);
  tp.keywords = splitList($("#f-keywords").value);
  tp.locations = splitList($("#f-locations").value);
  tp.location_filter = splitList($("#f-locfilter").value);
  tp.excluded_companies = splitList($("#f-excluded").value);
  tp.exclude_title_keywords = splitList($("#f-exclude-titles").value);
  tp.min_score = Math.max(0, Math.min(100, parseInt($("#f-min-score").value, 10) || 0));
  tp.scrape_sources = collectSources();
  try {
    await api("PUT", "/api/profile", {
      base_resume_text: $("#f-resume").value,
      base_cover_letter_text: $("#f-cover").value,
      target_preferences: tp,
    });
    $("#save-status").textContent = "Saved ✓";
    toast("Settings saved", "ok");
    setTimeout(() => ($("#save-status").textContent = ""), 2500);
  } catch (e) { $("#save-status").textContent = ""; toast(e.message, "err"); }
}

// --- view switching --------------------------------------------------------
function showView(id) {
  for (const v of ["view-dashboard", "view-settings", "view-applied", "view-errors", "view-rescore"]) {
    $("#" + v).classList.toggle("hidden", v !== id);
  }
}
function showSettings() { showView("view-settings"); loadSettings(); }
function showDashboard() { showView("view-dashboard"); loadJobs(); }
function showApplied() { showView("view-applied"); renderApplied(); }
function showErrors() { showView("view-errors"); loadErrors(); }
function showRescore() { showView("view-rescore"); loadRescore(); }

// --- Opus rescore impact -------------------------------------------------
const rescoreSign = (n) => (n > 0 ? "+" + n : "" + n);
const RESCORE_EDGES = [[-Infinity, -20], [-20, -10], [-10, -1], [-1, 1], [1, 10], [10, 20], [20, Infinity]];
const RESCORE_BUCKET_LABELS = ["dropped 20+", "dropped 10–20", "dropped 1–10", "unchanged", "rose 1–10", "rose 10–20", "rose 20+"];
function inRescoreBucket(d, i) { if (i === 3) return d === 0; const [lo, hi] = RESCORE_EDGES[i]; return d >= lo && d < hi; }
function findBoardJob(title, company) {
  const t = (title || "").toLowerCase().trim(), c = (company || "").toLowerCase().trim();
  return state.jobs.find((j) => (j.job_title || "").toLowerCase().trim() === t && (j.company_name || "").toLowerCase().trim() === c);
}
async function loadRescore() {
  try { state.rescore = await api("GET", "/api/rescore-stats"); state.rescoreBucket = null; renderRescore(); }
  catch (e) { $("#rescore-summary").innerHTML = `<p class="empty">Failed to load: ${esc(e.message)}</p>`; }
}
function renderRescore() {
  const s = state.rescore; if (!s) return;
  $("#rescore-count").textContent = s.total ? `· ${s.total} rescored` : "";
  if (!s.total) {
    $("#rescore-summary").innerHTML = "";
    $("#rescore-chart").innerHTML = `<p class="empty">No Opus rescores logged yet. They appear as scrapes (or a board re-score) send jobs above your rescore threshold through Opus.</p>`;
    $("#rescore-biggest").innerHTML = "";
    return;
  }
  $("#rescore-summary").innerHTML = [
    ["Rescored", s.total],
    ["Raised ↑", `${s.raised} (avg ${rescoreSign(s.avgUp)})`],
    ["Lowered ↓", `${s.lowered} (avg ${s.avgDown})`],
    ["Net avg Δ", rescoreSign(s.avgDelta)],
  ].map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v" style="font-size:18px">${v}</div></div>`).join("");

  // Clickable SVG bar chart of the delta distribution.
  const max = Math.max(1, ...s.buckets.map((b) => b.count));
  const W = 640, H = 200, padB = 34, padT = 10, barGap = 14;
  const n = s.buckets.length, bw = (W - barGap * (n + 1)) / n;
  const bars = s.buckets.map((b, i) => {
    const x = barGap + i * (bw + barGap);
    const h = Math.round((b.count / max) * (H - padB - padT));
    const y = H - padB - h;
    const sel = state.rescoreBucket === i;
    const color = i < 3 ? "var(--tier2)" : i === 3 ? "var(--tier3)" : "var(--tier1)";
    return `<rect data-bucket="${i}" x="${x}" y="${padT}" width="${bw}" height="${H - padB - padT}" fill="transparent" style="cursor:pointer"></rect>
      <rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="3" fill="${color}" opacity="${sel ? 1 : 0.8}" stroke="${sel ? "var(--text)" : "none"}" stroke-width="${sel ? 2 : 0}" style="pointer-events:none"></rect>
      <text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" font-size="11" fill="var(--muted)" style="pointer-events:none">${b.count || ""}</text>
      <text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle" font-size="10" fill="${sel ? "var(--text)" : "var(--muted)"}" style="pointer-events:none">${b.label}</text>`;
  }).join("");
  $("#rescore-chart").innerHTML =
    `<div class="hint" style="margin-bottom:6px">Score change (Opus − Haiku) · click a bar to see those jobs · <span style="color:var(--tier2)">▮</span> lowered &nbsp; <span style="color:var(--tier1)">▮</span> raised</div>
     <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">${bars}</svg>`;
  $$("#rescore-chart [data-bucket]").forEach((el) => (el.onclick = () => {
    const i = +el.dataset.bucket;
    state.rescoreBucket = state.rescoreBucket === i ? null : i;
    renderRescore();
  }));

  // Job list: either the selected bucket, or the biggest movers.
  let rows, heading;
  if (state.rescoreBucket != null) {
    rows = (s.entries || []).filter((e) => inRescoreBucket(e.delta, state.rescoreBucket)).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    heading = `Jobs that ${RESCORE_BUCKET_LABELS[state.rescoreBucket]} (${rows.length}) · <a class="link" id="rescore-clear">show biggest moves</a>`;
  } else {
    rows = s.biggest || [];
    heading = `Biggest moves <span class="hint">(click a bar above to filter)</span>`;
  }
  const dcol = (d) => (d >= 0 ? "var(--tier1)" : "var(--tier2)");
  const rowHtml = (e, idx) => {
    const j = findBoardJob(e.job_title, e.company_name);
    const why = `<div class="rescore-why hidden" data-why="${idx}">
        <div class="rw-line"><span class="rw-tag" style="color:var(--muted)">Haiku ${e.first_score}</span> ${esc(e.first_reasoning || "—")}</div>
        <div class="rw-line"><span class="rw-tag" style="color:${dcol(e.delta)}">Opus ${e.final_score}</span> ${esc(e.final_reasoning || "—")}</div>
        ${j ? `<a class="link rw-open" data-jobid="${j.id}">Open job →</a>` : `<span class="hint">not on board</span>`}
      </div>`;
    return `<div class="rescore-item">
      <div class="kv rescore-row" data-row="${idx}" style="cursor:pointer">
        <span>${esc(e.job_title || "")}${e.company_name ? ` <span class="hint">@ ${esc(e.company_name)}</span>` : ""}</span>
        <span><b>${e.first_score}→${e.final_score}</b> <span style="color:${dcol(e.delta)}">${rescoreSign(e.delta)}</span></span>
      </div>${why}</div>`;
  };
  $("#rescore-biggest").innerHTML = `<h3 style="font-size:15px;margin:0 0 8px">${heading} <span class="hint">· click a row to see why</span></h3>` +
    (rows.length ? rows.map(rowHtml).join("") : `<p class="empty">No jobs in this bucket.</p>`);
  $$("#rescore-biggest [data-row]").forEach((el) => (el.onclick = () => {
    const w = $(`#rescore-biggest [data-why="${el.dataset.row}"]`); if (w) w.classList.toggle("hidden");
  }));
  $$("#rescore-biggest [data-jobid]").forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); openDrawer(el.dataset.jobid); }));
  const clr = $("#rescore-clear"); if (clr) clr.onclick = (ev) => { ev.stopPropagation(); state.rescoreBucket = null; renderRescore(); };
}

// --- error log -------------------------------------------------------------
function errorsAsText(errs) {
  if (!errs.length) return "No errors logged.";
  return errs.map((e) =>
    `[${e.at}] ${e.context || ""}\n${e.message || ""}${e.job_id ? `\njob: ${e.job_id}` : ""}${e.detail ? `\n${e.detail}` : ""}`
  ).join("\n\n----------------------------------------\n\n");
}
async function loadErrors() {
  try {
    state.errors = await api("GET", "/api/errors");
    $("#errors-count").textContent = state.errors.length ? `· ${state.errors.length}` : "";
    $("#errors-pre").textContent = errorsAsText(state.errors);
  } catch (e) {
    $("#errors-pre").textContent = "Failed to load errors: " + e.message;
  }
}

// Render the jobs the user has applied to (status APPLIED), newest first.
function renderApplied() {
  const applied = state.jobs
    .filter((x) => x.status === "APPLIED")
    .sort((a, b) => tsOf(b.applied_at || b.scraped_at) - tsOf(a.applied_at || a.scraped_at));
  $("#applied-count").textContent = applied.length ? `· ${applied.length}` : "";
  const list = $("#applied-list");
  list.innerHTML = applied.length
    ? applied.map(appliedCard).join("")
    : `<p class="empty">No applications yet. Open a job, apply on the company site, then hit “Mark applied” — it shows up here.</p>`;
  $$("#applied-list .card").forEach((c) => (c.onclick = () => openDrawer(c.dataset.id)));
  // Show the bulk-remove button only when there's something to remove, and never
  // to read-only viewers (the server enforces that too).
  const rm = $("#btn-remove-applied");
  if (rm) rm.classList.toggle("hidden", !(applied.length && state.role !== "viewer"));
}
function appliedCard(j) {
  const when = j.applied_at ? `Applied ${timeAgo(j.applied_at)}` : "Applied";
  return `<div class="card" data-id="${j.id}">
    <div class="top">
      <div>
        <div class="title">${esc(j.job_title)}</div>
        <div class="sub">${esc(j.company_name)}${j.location ? " · " + esc(j.location) : ""}</div>
      </div>${ring(j.match_percentage)}
    </div>
    <div class="meta"><span class="badge st-APPLIED">applied</span><span>${when}</span>${j.scraped_at ? `<span class="ss-muted">Scraped ${timeAgo(j.scraped_at)}</span>` : ""}</div>
  </div>`;
}

// --- wire up ---------------------------------------------------------------
$("#btn-scrape").onclick = runScrape;
$("#btn-settings").onclick = showSettings;
$("#btn-applied").onclick = showApplied;
$("#btn-applied-back").onclick = showDashboard;
$("#btn-remove-applied").onclick = async () => {
  const n = state.jobs.filter((x) => x.status === "APPLIED").length;
  if (!n || !confirm(`Remove all ${n} applied job${n === 1 ? "" : "s"} from the board? This can't be undone.`)) return;
  try {
    const r = await api("DELETE", "/api/jobs/applied");
    toast(`Removed ${r.removed} applied job${r.removed === 1 ? "" : "s"}`, "ok");
    await loadJobs(); renderApplied();
  } catch (e) { toast(e.message, "err"); }
};
$("#btn-errors").onclick = showErrors;
$("#btn-errors-back").onclick = showDashboard;
$("#btn-rescore-impact").onclick = showRescore;
$("#btn-rescore-back").onclick = showDashboard;
$("#btn-errors-copy").onclick = async () => {
  try { await navigator.clipboard.writeText(errorsAsText(state.errors || [])); toast("Copied to clipboard", "ok"); }
  catch { toast("Copy failed — select the text manually", "warn"); }
};
$("#btn-errors-download").onclick = () => {
  const blob = new Blob([errorsAsText(state.errors || [])], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `job-agent-errors-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click(); URL.revokeObjectURL(a.href);
};
$("#btn-errors-clear").onclick = async () => {
  if (!confirm("Clear the error log?")) return;
  try { const r = await api("DELETE", "/api/errors"); toast(`Cleared ${r.removed} errors`, "ok"); loadErrors(); }
  catch (e) { toast(e.message, "err"); }
};
$("#btn-back").onclick = showDashboard;
$("#btn-save").onclick = saveSettings;
$("#btn-save-schedule").onclick = saveSchedule;
$("#btn-save-scoring").onclick = saveScoring;
$("#btn-reset-scoring").onclick = () => {
  const d = state.scoringDefaults; if (!d) return;
  $("#f-scoring-rubric").value = d.rubric || "";
  $("#f-scoring-calibration").value = d.calibration || "";
  $("#scoring-status").textContent = "Reset to default — click Save to apply.";
};
$("#btn-calib-run").onclick = async () => {
  const btn = $("#btn-calib-run"); btn.disabled = true;
  $("#calib-status").textContent = "Running Opus calibration + eval… (~1 min)";
  try {
    const r = await api("POST", "/api/calibration/run");
    if (r.ok) toast("Calibration proposal ready", "ok");
    else if (r.skipped) toast("Skipped: " + r.skipped, "warn");
    else if (r.error) toast("Calibration error: " + r.error, "err");
    await loadCalibration();
  } catch (e) { toast(e.message, "err"); }
  finally { btn.disabled = false; $("#calib-status").textContent = ""; }
};
$("#btn-scoretest").onclick = async () => {
  const body = {
    job_title: $("#t-title").value, company_name: $("#t-company").value,
    location: $("#t-location").value, job_description_raw: $("#t-desc").value,
  };
  if (!body.job_title.trim() || body.job_description_raw.trim().length < 20) {
    toast("Add a title and a description (20+ chars)", "warn"); return;
  }
  const btn = $("#btn-scoretest"); btn.disabled = true;
  $("#scoretest-status").textContent = "Scoring…"; $("#scoretest-result").innerHTML = "";
  try {
    const r = await api("POST", "/api/jobs/score-test", body);
    $("#scoretest-status").textContent = "";
    const color = r.match_percentage >= 85 ? "var(--tier1)" : r.match_percentage >= 65 ? "var(--tier2)" : "var(--tier3)";
    $("#scoretest-result").innerHTML = `<div class="panelbox" style="margin-top:12px">
      <div style="font-size:20px;font-weight:600;color:${color}">${r.match_percentage}% · ${esc((r.tier || "").replace("TIER_", "Tier "))}</div>
      <div class="hint" style="margin-top:6px">Detected experience requirement: ${esc(r.requirement || "none detected")}</div>
      <div style="margin-top:8px;line-height:1.5">${esc(r.match_reasoning || "")}</div>
    </div>`;
  } catch (e) { $("#scoretest-status").textContent = ""; toast(e.message, "err"); }
  finally { btn.disabled = false; }
};
$("#btn-rescore").onclick = async () => {
  if (!confirm("Re-score every job on the board with the current prompt? Scores and tiers update in place (nothing is deleted).")) return;
  const btn = $("#btn-rescore");
  btn.disabled = true; $("#rescore-status").textContent = "Re-scoring… (this can take a minute)";
  try {
    const r = await api("POST", "/api/jobs/rescore");
    $("#rescore-status").textContent = `Re-scored ${r.updated} of ${r.total} jobs.`;
    toast(`Re-scored ${r.updated} jobs`, "ok", { duration: 7000 });
  } catch (e) { $("#rescore-status").textContent = ""; toast(e.message, "err"); }
  finally { btn.disabled = false; }
};
$("#btn-add-time").onclick = () => {
  const div = document.createElement("div");
  div.innerHTML = timeRow("09:00");
  $("#sch-times").appendChild(div.firstChild);
  $$(".sch-time-del").forEach((b) => (b.onclick = () => b.closest(".time-row").remove()));
};
$("#btn-report").onclick = showReport;
$("#btn-add-source").onclick = () => {
  const div = document.createElement("div"); div.innerHTML = sourceRow({ url: "", label: "" }, Date.now());
  $("#sources-list").appendChild(div.firstChild); bindSources();
};
$("#btn-clear").onclick = async () => {
  if (!state.jobs.length) { toast("Board is already empty", "warn"); return; }
  if (!confirm(`Remove all ${state.jobs.length} jobs from the board? Your settings/profile are kept.`)) return;
  try {
    const r = await api("DELETE", "/api/jobs");
    toast(`Cleared ${r.removed} jobs`, "ok");
    await loadJobs();
  } catch (e) { toast(e.message, "err"); }
};
$("#filter-location").oninput = (e) => { state.filters.location = e.target.value; render(); };
$("#filter-company-btn").onclick = (e) => { e.stopPropagation(); $("#company-menu").classList.toggle("hidden"); };
$("#company-menu").onclick = (e) => e.stopPropagation(); // keep menu open while picking
document.addEventListener("click", () => $("#company-menu")?.classList.add("hidden"));
$("#company-search").oninput = (e) => { state.companyQuery = e.target.value; syncCompanyOptions(state.jobs); };
$("#company-clear").onclick = () => {
  state.filters.companies = []; state.companyQuery = ""; $("#company-search").value = "";
  syncCompanyOptions(state.jobs); render();
};
$("#filter-posted").onchange = (e) => { state.filters.posted = e.target.value; render(); };
$("#filter-scraped").onchange = (e) => { state.filters.scraped = e.target.value; render(); };
$("#filter-minscore").oninput = (e) => { state.filters.minScore = e.target.value; render(); };
$("#filter-sort").onchange = (e) => { state.filters.sort = e.target.value; render(); };
$("#filter-hide-actioned").onchange = (e) => { state.filters.hideActioned = e.target.checked; render(); };
$("#salary-min").oninput = () => renderSalaryInsights();
$("#salary-max").oninput = () => renderSalaryInsights();
$("#filter-clear").onclick = () => {
  state.filters = { location: "", companies: [], posted: "", scraped: "", minScore: "", sort: "score", hideActioned: true };
  state.companyQuery = "";
  $("#filter-location").value = ""; $("#company-search").value = ""; $("#filter-posted").value = "";
  $("#filter-scraped").value = ""; $("#filter-minscore").value = ""; $("#filter-sort").value = "score";
  $("#filter-hide-actioned").checked = true;
  syncCompanyOptions(state.jobs);
  render();
};
$("#drawer-backdrop").onclick = closeDrawer;
$("#report-backdrop").onclick = () => $("#report-modal").classList.add("hidden");
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); $("#report-modal").classList.add("hidden"); } });

loadHealth();
loadJobs();
loadStatus();

// Live countdown to the next scheduled scrape.
setInterval(tickCountdown, 1000);
// Pick up background (scheduled) scrapes without a manual refresh.
setInterval(() => { if (!state.scraping && !$("#view-dashboard").classList.contains("hidden")) { loadStatus(); loadJobs(); } }, 60000);
