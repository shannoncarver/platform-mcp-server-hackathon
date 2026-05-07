// `platform_auth0_clients` handler. Read-only listing/get of Auth0
// applications. The skill REFUSES to project credential material
// (client_secret, signing_keys, encryption_key) regardless of `fields`
// — this is a security property, not a usability one. Tested by
// test/clients.test.ts.

import { get } from "../auth0-client.js";
import { err, ok, type HandlerResult } from "../error-envelope.js";

const DEFAULT_CLIENT_FIELDS = [
  "client_id",
  "name",
  "description",
  "app_type",
  "is_first_party",
  "oidc_conformant",
  "grant_types",
  "token_endpoint_auth_method",
  "callbacks",
  "allowed_logout_urls",
  "web_origins",
  "allowed_origins",
  "initiate_login_uri",
  "jwt_configuration",
  "refresh_token",
  "sso",
  "cross_origin_authentication",
  "custom_login_page_on",
  "tenant",
];

const FORBIDDEN_CLIENT_FIELDS = new Set([
  "client_secret",
  "signing_keys",
  "encryption_key",
]);

export interface ClientsArgs {
  client_id?: unknown;
  name?: unknown;
  app_type?: unknown;
  is_first_party?: unknown;
  fields?: unknown;
  per_page?: unknown;
  max_pages?: unknown;
}

interface ResolvedFields {
  ok: true;
  fields: string;
  fieldList: string[];
}
interface RefusedFields {
  ok: false;
  envelope: ReturnType<typeof err>;
}

function resolveFields(requested: unknown): ResolvedFields | RefusedFields {
  const raw =
    typeof requested === "string" && requested.trim().length > 0
      ? requested
      : DEFAULT_CLIENT_FIELDS.join(",");
  const set = new Set(
    raw
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0),
  );
  const refused = [...set].filter((f) => FORBIDDEN_CLIENT_FIELDS.has(f));
  if (refused.length > 0) {
    return {
      ok: false,
      envelope: err(
        "bad_query",
        `Refused fields: ${refused.sort().join(", ")}`,
        "client_secret, signing_keys, and encryption_key are not retrievable via this skill by design (read-only operational verification). Use the Auth0 Dashboard for credential rotation.",
      ),
    };
  }
  // Even if the operator did not request a forbidden field, strip it
  // defensively. (Belt and braces — Auth0 should not return them either,
  // but we never want them to appear in this response.)
  for (const f of FORBIDDEN_CLIENT_FIELDS) set.delete(f);
  const list = [...set].sort();
  return { ok: true, fields: list.join(","), fieldList: list };
}

export async function runClients(
  domain: string,
  token: string,
  rawArgs: unknown,
): Promise<HandlerResult<unknown>> {
  const args = (rawArgs ?? {}) as ClientsArgs;
  const resolved = resolveFields(args.fields);
  if (!resolved.ok) return resolved.envelope;

  const clientId = typeof args.client_id === "string" ? args.client_id : null;
  if (clientId !== null) {
    const resp = await get<unknown>(
      domain,
      token,
      `clients/${encodeURIComponent(clientId)}`,
      { include_fields: "true", fields: resolved.fields },
    );
    return ok({
      client_id: clientId,
      fields: resolved.fields,
      client: stripForbidden(resp.body),
    });
  }

  const nameFilter = typeof args.name === "string" ? args.name.toLowerCase() : null;
  const appType = typeof args.app_type === "string" ? args.app_type : undefined;
  const isFirstParty =
    typeof args.is_first_party === "boolean" ? args.is_first_party : undefined;
  const perPage = clamp(asInt(args.per_page, 50), 1, 100);
  const maxPages = clamp(asInt(args.max_pages, 5), 1, 10);

  const all: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string | number | boolean | undefined> = {
      page,
      per_page: perPage,
      include_totals: "false",
      include_fields: "true",
      fields: resolved.fields,
    };
    if (appType !== undefined) params.app_type = appType;
    if (isFirstParty !== undefined) {
      params.is_first_party = isFirstParty ? "true" : "false";
    }
    const resp = await get<unknown>(domain, token, "clients", params);
    let pageItems: unknown[];
    if (Array.isArray(resp.body)) {
      pageItems = resp.body;
    } else if (resp.body !== null && typeof resp.body === "object") {
      const obj = resp.body as { clients?: unknown[] };
      pageItems = Array.isArray(obj.clients) ? obj.clients : [];
    } else {
      pageItems = [];
    }
    all.push(...pageItems);
    if (pageItems.length < perPage) break;
  }

  const filtered = nameFilter !== null
    ? all.filter((c) => {
        const n = (c as { name?: unknown }).name;
        return typeof n === "string" && n.toLowerCase().includes(nameFilter);
      })
    : all;

  return ok({
    filter: {
      name_substr: typeof args.name === "string" ? args.name : null,
      app_type: appType ?? null,
      is_first_party: isFirstParty ?? null,
    },
    fields: resolved.fields,
    fetched: all.length,
    matched: filtered.length,
    clients: filtered.map(stripForbidden),
  });
}

function stripForbidden(body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(stripForbidden);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (FORBIDDEN_CLIENT_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
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
