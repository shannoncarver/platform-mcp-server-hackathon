// `platform_auth0_stats` handler. Mirrors the Python skill's _run_stats.
//
// Window strings: today | yesterday | this-week | 24h | 7d | 14d | 30d |
// 90d | NNd | NNh. NNh floors to days for the date-keyed stats endpoint
// (matches the Python implementation's behavior).
//
// HACKATHON: log-derived metrics (failures / mfa-adoption / top-connections)
// page through /api/v2/logs at up to 1000 events per metric. Wide windows
// (e.g., 90d) may be slow; if the single-Lambda timeout becomes a problem
// the next iteration should split into a worker job. See prompt §6.

import { get } from "../auth0-client.js";
import { err, ok, type HandlerResult } from "../error-envelope.js";

const ALL_SECTIONS = [
  "daily",
  "mau",
  "failures",
  "mfa-adoption",
  "top-connections",
] as const;
type Section = (typeof ALL_SECTIONS)[number];

const LOG_FAILURE_TYPES = ["f", "fp", "fu", "fsa", "fco", "fcoa"] as const;
const LOG_MFA_TYPES = [
  "gd_auth_succeed",
  "gd_auth_failed",
  "gd_enrollment_complete",
  "mfar",
] as const;

export interface StatsArgs {
  window?: unknown;
  include?: unknown;
  exclude?: unknown;
}

export interface StatsResultData {
  window: { label: string; start: string; end: string; days: number };
  sections_fetched: string[];
  fetched_at: string;
  daily?: unknown[];
  mau?: number;
  failures?: { total: number; by_type: Record<string, number>; capped: boolean };
  mfa_adoption?: {
    successful_logins: number;
    mfa_events: number;
    adoption_rate: number;
    capped: boolean;
  };
  top_connections?: {
    total_successful_logins: number;
    top: Array<{ connection: string; logins: number }>;
    capped: boolean;
  };
}

export async function runStats(
  domain: string,
  token: string,
  rawArgs: unknown,
): Promise<HandlerResult<StatsResultData>> {
  const args = (rawArgs ?? {}) as StatsArgs;

  const include = typeof args.include === "string" ? args.include.trim() : "";
  const exclude = typeof args.exclude === "string" ? args.exclude.trim() : "";
  if (include.length > 0 && exclude.length > 0) {
    return err(
      "bad_query",
      "`include` and `exclude` are mutually exclusive.",
      "Pass at most one of `include` / `exclude`.",
    );
  }

  let sections: Section[];
  if (include.length > 0) {
    const requested = include.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const unknown = requested.filter((s) => !ALL_SECTIONS.includes(s as Section));
    if (unknown.length > 0) {
      return err(
        "bad_query",
        `Unknown include section(s): ${unknown.join(", ")}`,
        `Valid sections: ${ALL_SECTIONS.join(", ")}`,
      );
    }
    sections = requested as Section[];
  } else if (exclude.length > 0) {
    const excluded = new Set(exclude.split(",").map((s) => s.trim()));
    sections = ALL_SECTIONS.filter((s) => !excluded.has(s));
  } else {
    sections = [...ALL_SECTIONS];
  }

  const windowLabel = typeof args.window === "string" ? args.window : "7d";
  const parsed = parseWindow(windowLabel);
  if (parsed.kind === "err") {
    return err(
      "bad_window",
      `Unrecognized window value: ${JSON.stringify(windowLabel)}`,
      "Use one of: today, yesterday, this-week, 24h, 7d, 14d, 30d, 90d, or NNd / NNh.",
    );
  }
  const { start, end } = parsed;

  const result: StatsResultData = {
    window: {
      label: windowLabel,
      start: isoDate(start),
      end: isoDate(end),
      days: Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1,
    },
    sections_fetched: sections,
    fetched_at: new Date().toISOString(),
  };

  if (sections.includes("daily")) {
    result.daily = await daily(domain, token, start, end);
  }
  if (sections.includes("mau")) {
    result.mau = await mau(domain, token);
  }
  if (sections.includes("failures")) {
    result.failures = await failures(domain, token, start, end);
  }
  if (sections.includes("mfa-adoption")) {
    result.mfa_adoption = await mfaAdoption(domain, token, start, end);
  }
  if (sections.includes("top-connections")) {
    result.top_connections = await topConnections(domain, token, start, end);
  }

  return ok(result);
}

async function daily(
  domain: string,
  token: string,
  start: Date,
  end: Date,
): Promise<unknown[]> {
  const resp = await get<unknown>(domain, token, "stats/daily", {
    from: yyyymmdd(start),
    to: yyyymmdd(end),
  });
  return Array.isArray(resp.body) ? (resp.body as unknown[]) : [];
}

async function mau(domain: string, token: string): Promise<number> {
  const resp = await get<unknown>(domain, token, "stats/active-users", {});
  if (typeof resp.body === "number") return resp.body;
  if (resp.body !== null && typeof resp.body === "object") {
    const o = resp.body as { active_users?: number };
    if (typeof o.active_users === "number") return o.active_users;
  }
  return 0;
}

async function failures(
  domain: string,
  token: string,
  start: Date,
  end: Date,
): Promise<{ total: number; by_type: Record<string, number>; capped: boolean }> {
  const typeClause = LOG_FAILURE_TYPES.map((t) => `type:${t}`).join(" OR ");
  const dateClause = `date:[${isoDate(start)} TO ${isoDate(end)}]`;
  const logs = await pageLogs(domain, token, `(${typeClause}) AND ${dateClause}`);
  const byType: Record<string, number> = {};
  for (const log of logs) {
    const t = (log as { type?: unknown }).type;
    if (typeof t === "string") byType[t] = (byType[t] ?? 0) + 1;
  }
  return { total: logs.length, by_type: byType, capped: logs.length >= 1000 };
}

async function mfaAdoption(
  domain: string,
  token: string,
  start: Date,
  end: Date,
): Promise<{ successful_logins: number; mfa_events: number; adoption_rate: number; capped: boolean }> {
  const dateClause = `date:[${isoDate(start)} TO ${isoDate(end)}]`;
  const successes = await pageLogs(domain, token, `type:s AND ${dateClause}`);
  const mfaQuery =
    "(" + LOG_MFA_TYPES.map((t) => `type:${t}`).join(" OR ") + ") AND " + dateClause;
  const mfaEvents = await pageLogs(domain, token, mfaQuery);
  const rate = successes.length === 0 ? 0 : mfaEvents.length / successes.length;
  return {
    successful_logins: successes.length,
    mfa_events: mfaEvents.length,
    adoption_rate: Math.round(rate * 1000) / 1000,
    capped: successes.length >= 1000 || mfaEvents.length >= 1000,
  };
}

async function topConnections(
  domain: string,
  token: string,
  start: Date,
  end: Date,
): Promise<{ total_successful_logins: number; top: Array<{ connection: string; logins: number }>; capped: boolean }> {
  const dateClause = `date:[${isoDate(start)} TO ${isoDate(end)}]`;
  const logs = await pageLogs(domain, token, `type:s AND ${dateClause}`);
  const counts: Record<string, number> = {};
  for (const log of logs) {
    const c = (log as { connection?: unknown }).connection;
    const key = typeof c === "string" && c.length > 0 ? c : "<unknown>";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([connection, logins]) => ({ connection, logins }));
  return { total_successful_logins: logs.length, top, capped: logs.length >= 1000 };
}

async function pageLogs(
  domain: string,
  token: string,
  query: string,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 0; page < 10; page++) {
    const resp = await get<unknown>(domain, token, "logs", {
      q: query,
      page,
      per_page: 100,
      sort: "date:-1",
      include_totals: "true",
    });
    let pageLogs: unknown[];
    if (Array.isArray(resp.body)) {
      pageLogs = resp.body as unknown[];
    } else if (resp.body !== null && typeof resp.body === "object") {
      const obj = resp.body as { logs?: unknown[] };
      pageLogs = Array.isArray(obj.logs) ? obj.logs : [];
    } else {
      pageLogs = [];
    }
    out.push(...pageLogs);
    if (pageLogs.length < 100) break;
    if (out.length >= 1000) break;
  }
  return out;
}

interface WindowOk {
  kind: "ok";
  start: Date;
  end: Date;
}
interface WindowErr {
  kind: "err";
}

function parseWindow(raw: string): WindowOk | WindowErr {
  const today = startOfUtcDay(new Date());
  const w = raw.trim().toLowerCase();
  if (w === "today") return { kind: "ok", start: today, end: today };
  if (w === "yesterday") {
    const y = addDays(today, -1);
    return { kind: "ok", start: y, end: y };
  }
  if (w === "this-week") {
    const dow = today.getUTCDay() === 0 ? 6 : today.getUTCDay() - 1;
    return { kind: "ok", start: addDays(today, -dow), end: today };
  }
  if (w === "24h" || w === "1d") {
    return { kind: "ok", start: addDays(today, -1), end: today };
  }
  const dMatch = /^(\d+)d$/.exec(w);
  if (dMatch !== null) {
    const n = Number.parseInt(dMatch[1], 10);
    return { kind: "ok", start: addDays(today, -n), end: today };
  }
  const hMatch = /^(\d+)h$/.exec(w);
  if (hMatch !== null) {
    const n = Number.parseInt(hMatch[1], 10);
    return { kind: "ok", start: addDays(today, -Math.max(1, Math.floor(n / 24))), end: today };
  }
  return { kind: "err" };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear().toString();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${day}`;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}
