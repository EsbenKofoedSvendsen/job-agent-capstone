"""Job concierge — a Google ADK agent that fronts the Job Agent system.

The always-on pipeline (Claude cascade, see ../src) does the heavy lifting;
this Gemini-powered concierge gives it a conversational interface: ask for
your best matches, paste a posting to score it, or check pipeline health.

Env:
  GOOGLE_API_KEY       Gemini API key (aistudio.google.com -> Get API key)
  JOB_AGENT_URL        e.g. https://your-app.fly.dev (default http://localhost:5179)
  JOB_AGENT_PASSWORD   the app's APP_PASSWORD (omit if unset)
"""
import base64
import json
import os
import ssl
import urllib.request

from google.adk.agents import Agent

_BASE = os.environ.get("JOB_AGENT_URL", "http://localhost:5179").rstrip("/")
_PW = os.environ.get("JOB_AGENT_PASSWORD", "")

try:  # python.org macOS builds often lack system root certs; certifi ships with ADK
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = ssl.create_default_context()


def _api(method: str, path: str, body: dict | None = None) -> dict | list:
    req = urllib.request.Request(_BASE + path, method=method)
    if _PW:
        token = base64.b64encode(f"adk:{_PW}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    data = None
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data=data, timeout=120, context=_SSL_CTX) as res:
        return json.loads(res.read().decode())


def list_top_jobs(min_score: int = 80, limit: int = 10) -> dict:
    """List the best job matches currently on the board, highest score first.

    Args:
        min_score: only include jobs at or above this match score (0-100).
        limit: maximum number of jobs to return.
    """
    jobs = _api("GET", "/api/jobs")
    if isinstance(jobs, dict):
        jobs = jobs.get("jobs", [])
    rows = [
        {
            "score": j.get("match_percentage"),
            "tier": j.get("tier"),
            "title": j.get("job_title"),
            "company": j.get("company_name"),
            "location": j.get("location"),
            "url": j.get("job_url"),
            "reasoning": j.get("match_reasoning"),
        }
        for j in jobs
        if (j.get("match_percentage") or 0) >= min_score and j.get("status") != "REJECTED"
    ]
    rows.sort(key=lambda r: r["score"] or 0, reverse=True)
    return {"count": len(rows[:limit]), "jobs": rows[:limit]}


def score_job(job_title: str, job_description: str, company_name: str = "", location: str = "") -> dict:
    """Score a pasted job posting against the owner's resume (nothing is saved).

    Args:
        job_title: the posting's title.
        job_description: the posting text (at least 20 characters).
        company_name: optional company name.
        location: optional location string.
    """
    r = _api("POST", "/api/jobs/score-test", {
        "job_title": job_title,
        "company_name": company_name,
        "location": location,
        "job_description_raw": job_description,
    })
    return {
        "score": r.get("match_percentage"),
        "tier": r.get("tier"),
        "reasoning": r.get("match_reasoning"),
        "stated_requirement": r.get("requirement"),
    }


def source_health() -> dict:
    """Report per-source health from the latest scrape: which career sites are
    returning jobs (ok), loading but empty, or erroring."""
    h = _api("GET", "/api/sources/health")
    summary: dict[str, int] = {}
    worst = []
    for url, v in h.items():
        summary[v["status"]] = summary.get(v["status"], 0) + 1
        if v["status"] != "ok":
            worst.append({"url": url, "status": v["status"], "error": v.get("error")})
    return {"summary": summary, "not_ok": worst[:15]}


def agent_status() -> dict:
    """Scheduler state, next scheduled run, and the last scrape results."""
    return _api("GET", "/api/status")


root_agent = Agent(
    name="job_concierge",
    model="gemini-2.5-flash",
    description="Personal job-search concierge over an always-on scraping and scoring pipeline.",
    instruction=(
        "You are the owner's job-search concierge. The heavy lifting (scraping ~70 "
        "career sites, scoring against the resume) runs autonomously; you answer "
        "questions on top of it. Use list_top_jobs for 'what's new / best matches', "
        "score_job when the user pastes a posting, source_health and agent_status "
        "for pipeline questions. Be concise; lead with scores and company names; "
        "always include the job URL when recommending a specific posting. Scores: "
        "85+ is a strong match worth applying to, 70-84 solid, below 65 discarded."
    ),
    tools=[list_top_jobs, score_job, source_health, agent_status],
)
