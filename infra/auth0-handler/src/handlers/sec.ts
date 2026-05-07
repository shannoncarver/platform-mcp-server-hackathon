// `platform_auth0_sec` handler. Mirrors the Python skill's _run_sec.
//
// Subject classification:
//   IPv4 / IPv6      → ip block + recent activity
//   email            → user-blocks?identifier=<email>
//   user_id (auth0|) → /user-blocks/<user_id>
//   "policy" / "config" / "settings" / "configuration" → all three
//                       attack-protection policies
//   "status" / ""    → policy summary (= "policy" + a hint)
//
// Note on Auth0 endpoint paths: Python source uses
// /api/v2/anomaly/blocks/ips/<ip>; we match that exactly.

import { get } from "../auth0-client.js";
import { err, ok, type HandlerResult } from "../error-envelope.js";

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
const USER_ID_PREFIXES = [
  "auth0|",
  "google-oauth2|",
  "windowslive|",
  "github|",
  "facebook|",
  "linkedin|",
  "twitter|",
  "samlp|",
  "oidc|",
  "email|",
  "sms|",
  "waad|",
  "adfs|",
  "ad|",
];
const POLICY_KEYWORDS = new Set(["policy", "config", "settings", "configuration"]);
const STATUS_KEYWORDS = new Set(["status", "posture", "overview", "summary", "all", ""]);

export interface SecArgs {
  subject?: unknown;
  days?: unknown;
}

type SubjectKind = "ip" | "email" | "user_id" | "policy" | "status" | "unknown";

export function classifySubject(subject: string): SubjectKind {
  const s = subject.trim();
  if (IPV4_RE.test(s)) return "ip";
  if (s.includes(":") && IPV6_RE.test(s) && !s.includes("|")) return "ip";
  if (s.includes("@") && !s.includes("|")) return "email";
  if (USER_ID_PREFIXES.some((p) => s.startsWith(p))) return "user_id";
  const lowered = s.toLowerCase();
  if (POLICY_KEYWORDS.has(lowered)) return "policy";
  if (STATUS_KEYWORDS.has(lowered)) return "status";
  return "unknown";
}

export async function runSec(
  domain: string,
  token: string,
  rawArgs: unknown,
): Promise<HandlerResult<unknown>> {
  const args = (rawArgs ?? {}) as SecArgs;
  const subject = typeof args.subject === "string" ? args.subject : "status";
  const days = clamp(asInt(args.days, 7), 1, 90);

  const kind = classifySubject(subject);
  if (kind === "unknown") {
    return err(
      "bad_subject",
      `Could not classify subject: ${JSON.stringify(subject)}`,
      "Pass an IP (1.2.3.4), email (x@linq.com), user_id (auth0|...), or 'policy' / 'status'.",
    );
  }

  const fetchedAt = new Date().toISOString();

  if (kind === "ip") {
    const block = await ipBlockStatus(domain, token, subject);
    const recent = await recentIpActivity(domain, token, subject, days);
    return ok({
      subject,
      subject_kind: "ip",
      fetched_at: fetchedAt,
      block,
      recent_activity: recent,
    });
  }
  if (kind === "email") {
    const blocks = await userBlocksByIdentifier(domain, token, subject);
    return ok({
      subject,
      subject_kind: "email",
      fetched_at: fetchedAt,
      identifier: subject,
      blocks,
    });
  }
  if (kind === "user_id") {
    const result = await userBlocksById(domain, token, subject);
    return ok({
      subject,
      subject_kind: "user_id",
      fetched_at: fetchedAt,
      ...result,
    });
  }
  if (kind === "policy") {
    const policies = await allPolicies(domain, token);
    return ok({
      subject,
      subject_kind: "policy",
      fetched_at: fetchedAt,
      policies,
    });
  }
  // status
  const policies = await allPolicies(domain, token);
  return ok({
    subject,
    subject_kind: "status",
    fetched_at: fetchedAt,
    policies,
    note:
      "No specific subject probed. Pass an IP, email, or user_id to drill into a single target.",
  });
}

async function ipBlockStatus(
  domain: string,
  token: string,
  ip: string,
): Promise<{ ip: string; blocked: boolean; details?: unknown }> {
  const resp = await get<unknown>(domain, token, `anomaly/blocks/ips/${encodeURIComponent(ip)}`, {});
  if (resp.status === 404) return { ip, blocked: false };
  if (resp.status === 200 || resp.status === 204) {
    return { ip, blocked: true, details: resp.body };
  }
  // Other statuses already mapped to Auth0Error in `get`; this branch
  // is unreachable but keeps the type checker happy.
  return { ip, blocked: false };
}

async function userBlocksByIdentifier(
  domain: string,
  token: string,
  identifier: string,
): Promise<unknown> {
  const resp = await get<unknown>(domain, token, "user-blocks", { identifier });
  return resp.body;
}

async function userBlocksById(
  domain: string,
  token: string,
  user_id: string,
): Promise<{ user_id: string; blocks: unknown; note?: string }> {
  const resp = await get<unknown>(
    domain,
    token,
    `user-blocks/${encodeURIComponent(user_id)}`,
    {},
  );
  if (resp.status === 404) return { user_id, blocks: {}, note: "user not found" };
  return { user_id, blocks: resp.body };
}

async function allPolicies(
  domain: string,
  token: string,
): Promise<{
  breached_password_detection: unknown;
  brute_force_protection: unknown;
  suspicious_ip_throttling: unknown;
}> {
  const [breached, brute, suspicious] = await Promise.all([
    get(domain, token, "attack-protection/breached-password-detection", {}),
    get(domain, token, "attack-protection/brute-force-protection", {}),
    get(domain, token, "attack-protection/suspicious-ip-throttling", {}),
  ]);
  return {
    breached_password_detection: breached.body,
    brute_force_protection: brute.body,
    suspicious_ip_throttling: suspicious.body,
  };
}

async function recentIpActivity(
  domain: string,
  token: string,
  ip: string,
  days: number,
): Promise<{
  ip: string;
  window_days: number;
  events: number;
  by_type: Record<string, number>;
  top_users: Array<{ user: string; events: number }>;
}> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const dateClause = `date:[${isoDate(start)} TO ${isoDate(end)}]`;
  const query = `ip:"${ip}" AND ${dateClause}`;

  const all: unknown[] = [];
  for (let page = 0; page < 2; page++) {
    const resp = await get<unknown>(domain, token, "logs", {
      q: query,
      page,
      per_page: 100,
      sort: "date:-1",
      include_totals: "true",
    });
    let pageLogs: unknown[];
    if (Array.isArray(resp.body)) {
      pageLogs = resp.body;
    } else if (resp.body !== null && typeof resp.body === "object") {
      const obj = resp.body as { logs?: unknown[] };
      pageLogs = Array.isArray(obj.logs) ? obj.logs : [];
    } else {
      pageLogs = [];
    }
    all.push(...pageLogs);
    if (pageLogs.length < 100) break;
  }

  const byType: Record<string, number> = {};
  const byUser: Record<string, number> = {};
  for (const log of all) {
    const o = log as { type?: unknown; user_name?: unknown; user_id?: unknown };
    if (typeof o.type === "string") byType[o.type] = (byType[o.type] ?? 0) + 1;
    const userKey =
      typeof o.user_name === "string" && o.user_name.length > 0
        ? o.user_name
        : typeof o.user_id === "string" && o.user_id.length > 0
          ? o.user_id
          : "<anonymous>";
    byUser[userKey] = (byUser[userKey] ?? 0) + 1;
  }
  const topUsers = Object.entries(byUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([user, events]) => ({ user, events }));
  return { ip, window_days: days, events: all.length, by_type: byType, top_users: topUsers };
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear().toString();
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
