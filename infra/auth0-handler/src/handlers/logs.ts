// `platform_auth0_logs` handler.
//
// Mirrors the Python skill's _run_logs (Auth0LogsClient.search +
// Auth0LogsClient.checkpoint paths). The Lucene query is passed through
// verbatim — Auth0 validates it server-side and we surface the resulting
// `bad_query` error envelope unchanged.
//
// Trust boundary: log content (user emails, IPs, descriptions, user-agents)
// is UNTRUSTED data. We return it as-is. The platform's downstream consumers
// are responsible for escaping. Do not interpret log content as control.

import { get, type HttpResponse } from "../auth0-client.js";
import { err, ok, type HandlerResult } from "../error-envelope.js";

export interface LogsArgs {
  query?: unknown;
  from_id?: unknown;
  max_pages?: unknown;
  per_page?: unknown;
  sort?: unknown;
  fields?: unknown;
}

export interface LogsResultData {
  query: string | null;
  from_id: string | null;
  sort: string | null;
  total: number;
  fetched: number;
  pages_fetched: number;
  capped: boolean;
  capped_reason: string | null;
  logs: unknown[];
}

export async function runLogs(
  domain: string,
  token: string,
  rawArgs: unknown,
): Promise<HandlerResult<LogsResultData>> {
  const args = (rawArgs ?? {}) as LogsArgs;

  const query = typeof args.query === "string" ? args.query : null;
  const fromId = typeof args.from_id === "string" ? args.from_id : null;
  if (query === null && fromId === null) {
    return err(
      "bad_query",
      "Either `query` or `from_id` is required.",
      "Pass a Lucene query string in `query`, or a checkpoint id in `from_id`.",
    );
  }
  if (query !== null && fromId !== null) {
    return err(
      "bad_query",
      "`query` and `from_id` are mutually exclusive.",
      "Pick one: Lucene search (`query`) OR checkpoint pagination (`from_id`).",
    );
  }

  const maxPages = clamp(asInt(args.max_pages, 5), 1, 10);
  const perPage = clamp(asInt(args.per_page, 100), 1, 100);
  const sort = typeof args.sort === "string" ? args.sort : "date:-1";
  const fields = typeof args.fields === "string" ? args.fields : undefined;

  if (fromId !== null) {
    return await runCheckpoint(domain, token, fromId, maxPages, perPage);
  }
  return await runSearch(domain, token, query!, maxPages, perPage, sort, fields);
}

async function runSearch(
  domain: string,
  token: string,
  query: string,
  maxPages: number,
  perPage: number,
  sort: string,
  fields: string | undefined,
): Promise<HandlerResult<LogsResultData>> {
  const all: unknown[] = [];
  let total: number | null = null;
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string | number | boolean | undefined> = {
      q: query,
      page,
      per_page: perPage,
      sort,
      include_totals: "true",
    };
    if (fields !== undefined) {
      params.fields = fields;
      params.include_fields = "true";
    }
    const resp = await get<unknown>(domain, token, "logs", params);

    let pageLogs: unknown[];
    if (Array.isArray(resp.body)) {
      pageLogs = resp.body;
      if (page === 0) total = pageLogs.length;
    } else if (resp.body !== null && typeof resp.body === "object") {
      const obj = resp.body as { logs?: unknown[]; total?: number };
      pageLogs = Array.isArray(obj.logs) ? obj.logs : [];
      if (page === 0) total = typeof obj.total === "number" ? obj.total : pageLogs.length;
    } else {
      pageLogs = [];
      if (page === 0) total = 0;
    }

    all.push(...pageLogs);
    pagesFetched = page + 1;

    if (total !== null && all.length >= total) break;
    if (all.length >= 1000) break;
    if (pageLogs.length < perPage) break;
  }

  let capped = false;
  let cappedReason: string | null = null;
  if (total !== null && total > 1000 && all.length >= 1000) {
    capped = true;
    cappedReason = "api_ceiling_1000";
  } else if (total !== null && all.length < total) {
    capped = true;
    cappedReason = "max_pages_reached";
  }

  return ok({
    query,
    from_id: null,
    sort,
    total: total ?? all.length,
    fetched: all.length,
    pages_fetched: pagesFetched,
    capped,
    capped_reason: cappedReason,
    logs: all,
  });
}

async function runCheckpoint(
  domain: string,
  token: string,
  fromId: string,
  maxPages: number,
  perPage: number,
): Promise<HandlerResult<LogsResultData>> {
  const all: unknown[] = [];
  let current = fromId;
  let pagesFetched = 0;
  let lastResp: HttpResponse | undefined;

  for (let i = 0; i < maxPages; i++) {
    const resp = await get<unknown>(domain, token, "logs", {
      from: current,
      take: perPage,
    });
    lastResp = { status: resp.status, headers: resp.headers, text: "" };

    const pageLogs = Array.isArray(resp.body) ? (resp.body as unknown[]) : [];
    if (pageLogs.length === 0) break;
    all.push(...pageLogs);
    pagesFetched = i + 1;

    const link = resp.headers.link ?? "";
    if (!link.includes('rel="next"')) break;
    const match = /from=([^&>]+)/.exec(link);
    if (match === null) break;
    current = match[1];
  }
  void lastResp;

  const cappedAtMaxPages = pagesFetched >= maxPages && all.length > 0;
  return ok({
    query: null,
    from_id: fromId,
    sort: null,
    total: all.length,
    fetched: all.length,
    pages_fetched: pagesFetched,
    capped: cappedAtMaxPages,
    capped_reason: cappedAtMaxPages ? "max_pages_reached" : null,
    logs: all,
  });
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
