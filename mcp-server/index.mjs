#!/usr/bin/env node
// MCP stdio server for the Job Agent. Exposes the live agent's REST API as
// Model Context Protocol tools so any MCP client (Claude Desktop, Gemini CLI,
// Antigravity, ...) can query the board, score postings, and check health.
//
// Config via env:
//   JOB_AGENT_URL       e.g. https://your-app.fly.dev  (default http://localhost:5179)
//   JOB_AGENT_PASSWORD  the app's APP_PASSWORD (omit if the app runs without auth)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.JOB_AGENT_URL || "http://localhost:5179").replace(/\/$/, "");
const AUTH = process.env.JOB_AGENT_PASSWORD
  ? "Basic " + Buffer.from(`mcp:${process.env.JOB_AGENT_PASSWORD}`).toString("base64")
  : null;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(AUTH ? { authorization: AUTH } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

const server = new McpServer({ name: "job-agent", version: "1.0.0" });

server.tool(
  "list_jobs",
  "List jobs on the board, best matches first. Optionally filter by minimum score and cap the count.",
  { min_score: z.number().optional().describe("Only jobs at/above this score (0-100)"), limit: z.number().optional().describe("Max jobs to return (default 20)") },
  async ({ min_score = 0, limit = 20 }) => {
    const jobs = await api("GET", "/api/jobs");
    const rows = (Array.isArray(jobs) ? jobs : jobs.jobs || [])
      .filter((j) => (j.match_percentage || 0) >= min_score && j.status !== "REJECTED")
      .sort((a, b) => (b.match_percentage || 0) - (a.match_percentage || 0))
      .slice(0, limit)
      .map((j) => ({
        score: j.match_percentage, tier: j.tier, title: j.job_title,
        company: j.company_name, location: j.location, url: j.job_url,
        reasoning: j.match_reasoning,
      }));
    return text({ count: rows.length, jobs: rows });
  }
);

server.tool(
  "score_job",
  "Score a pasted job posting against the owner's resume using the calibrated scoring cascade. Nothing is saved.",
  {
    job_title: z.string(),
    company_name: z.string().optional(),
    location: z.string().optional(),
    job_description: z.string().describe("The posting text (20+ chars)"),
  },
  async ({ job_title, company_name, location, job_description }) => {
    const r = await api("POST", "/api/jobs/score-test", {
      job_title, company_name, location, job_description_raw: job_description,
    });
    return text({ score: r.match_percentage, tier: r.tier, reasoning: r.match_reasoning, stated_requirement: r.requirement });
  }
);

server.tool(
  "source_health",
  "Per-source health from the latest scrape: ok (returned jobs), empty (loaded, none), or error — with job counts and adapter used.",
  {},
  async () => {
    const h = await api("GET", "/api/sources/health");
    const rows = Object.entries(h).map(([url, v]) => ({ url, ...v }));
    const summary = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    return text({ summary, sources: rows });
  }
);

server.tool(
  "agent_status",
  "Scheduler state, next run time, and the last automatic/manual scrape results.",
  {},
  async () => text(await api("GET", "/api/status"))
);

server.tool(
  "trigger_scrape",
  "Run a full scrape now (takes minutes and costs real LLM tokens — confirm with the user before calling).",
  {},
  async () => {
    const r = await api("POST", "/api/scrape/run");
    return text({ inserted: r.inserted ?? r.total_inserted, emailed: r.emailed });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
