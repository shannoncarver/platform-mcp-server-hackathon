// Minimal Auth0 Management API v2 client.
//
// HACKATHON: no token caching — see prompt §2.5; we mint a fresh token
// on every call. Productionizing this is a follow-up concern.
//
// All Auth0 HTTP calls route through `request()` so error-category
// mapping (auth_failed / rate_limited / uri_too_large / bad_query /
// api_error) stays consistent across handlers. The Python skill's
// `_auth0_common.auth0_get` is the spec for that mapping.

import * as https from "node:https";
import { URLSearchParams } from "node:url";
import { err, type ErrorEnvelope } from "./error-envelope.js";

/**
 * Pluggable HTTP seam. Production uses node `https`; tests inject a fake
 * that returns canned responses without touching the network.
 */
export interface HttpFetcher {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** Throw this internally — the entry handler catches it and returns the envelope. */
export class Auth0Error extends Error {
  constructor(public readonly envelope: ErrorEnvelope) {
    super(envelope.error.detail);
    this.name = "Auth0Error";
  }
}

const httpsFetcher: HttpFetcher = {
  request(req): Promise<HttpResponse> {
    const url = new URL(req.url);
    const bodyBuf =
      req.body !== undefined ? Buffer.from(req.body, "utf8") : undefined;
    const headers: Record<string, string> = { ...req.headers };
    if (bodyBuf !== undefined) {
      headers["content-length"] = bodyBuf.byteLength.toString();
    }
    return new Promise<HttpResponse>((resolve, reject) => {
      const r = https.request(
        {
          method: req.method,
          hostname: url.hostname,
          path: url.pathname + (url.search ?? ""),
          headers,
          timeout: 25_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const respHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === "string") respHeaders[k.toLowerCase()] = v;
              else if (Array.isArray(v)) respHeaders[k.toLowerCase()] = v.join(",");
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: respHeaders,
              text,
            });
          });
        },
      );
      r.on("timeout", () => r.destroy(new Error("auth0 request timeout")));
      r.on("error", reject);
      if (bodyBuf !== undefined) r.write(bodyBuf);
      r.end();
    });
  },
};

let activeFetcher: HttpFetcher = httpsFetcher;

export function setFetcherForTesting(fetcher: HttpFetcher): void {
  activeFetcher = fetcher;
}

export function _resetFetcherForTesting(): void {
  activeFetcher = httpsFetcher;
}

/** Mint a fresh M2M access token via the Auth0 token endpoint. */
export async function mintToken(
  domain: string,
  client_id: string,
  client_secret: string,
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id,
    client_secret,
    audience: `https://${domain}/api/v2/`,
  }).toString();
  const resp = await activeFetcher.request({
    method: "POST",
    url: `https://${domain}/oauth/token`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Auth0Error(
      err(
        "auth_failed",
        `${resp.status} from token endpoint: ${truncate(resp.text)}`,
        "Check the Auth0 M2M client_id/client_secret stored in Secrets Manager and the application's authorized scopes.",
      ),
    );
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Auth0Error(
      err(
        "api_error",
        `${resp.status} from token endpoint: ${truncate(resp.text)}`,
        "Auth0 token endpoint returned an unexpected status.",
      ),
    );
  }
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(resp.text) as { access_token?: string };
  } catch {
    throw new Auth0Error(
      err(
        "api_error",
        "Auth0 token response was not valid JSON.",
        "Re-run; if persistent, check the Auth0 tenant status.",
      ),
    );
  }
  if (parsed.access_token === undefined || parsed.access_token.length === 0) {
    throw new Auth0Error(
      err(
        "api_error",
        "Auth0 token response missing access_token.",
        "Re-run; if persistent, check the Auth0 tenant status.",
      ),
    );
  }
  return parsed.access_token;
}

/** GET against the Auth0 Management API; returns parsed JSON or throws Auth0Error. */
export async function get<T = unknown>(
  domain: string,
  token: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<{ status: number; body: T; headers: Record<string, string> }> {
  return doRequest<T>(domain, token, "GET", path, query);
}

async function doRequest<T>(
  domain: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): Promise<{ status: number; body: T; headers: Record<string, string> }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    qs.append(k, String(v));
  }
  const url = `https://${domain}/api/v2/${path}${qs.toString() ? `?${qs.toString()}` : ""}`;
  const resp = await activeFetcher.request({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
  });
  return mapResponse<T>(resp, url);
}

function mapResponse<T>(
  resp: HttpResponse,
  url: string,
): { status: number; body: T; headers: Record<string, string> } {
  // 200/204 happy path.
  if (resp.status === 200 || resp.status === 204) {
    let body: unknown;
    try {
      body = resp.text.length > 0 ? JSON.parse(resp.text) : {};
    } catch {
      body = resp.text;
    }
    return { status: resp.status, body: body as T, headers: resp.headers };
  }
  // 404 is sometimes a "not blocked / not found" signal — let callers handle.
  if (resp.status === 404) {
    let body: unknown;
    try {
      body = resp.text.length > 0 ? JSON.parse(resp.text) : {};
    } catch {
      body = {};
    }
    return { status: resp.status, body: body as T, headers: resp.headers };
  }
  if (resp.status === 400) {
    throw new Auth0Error(
      err(
        "bad_query",
        `400 Bad Request from ${url}: ${truncate(resp.text)}`,
        "Check the query syntax — field names, date format, special-character escaping.",
      ),
    );
  }
  if (resp.status === 414) {
    throw new Auth0Error(
      err(
        "uri_too_large",
        `414 Request-URI Too Large from ${url}`,
        "Simplify the query: fewer filters, shorter date ranges.",
      ),
    );
  }
  if (resp.status === 429) {
    throw new Auth0Error(
      err(
        "rate_limited",
        "429 from Auth0 — rate limit exceeded.",
        "Wait briefly and retry, or narrow the query.",
      ),
    );
  }
  if (resp.status === 401 || resp.status === 403) {
    const detail = truncate(resp.text);
    const hint = detail.toLowerCase().includes("scope")
      ? "The M2M app lacks a required scope. Add it in the Auth0 Dashboard (Applications → [your app] → APIs → Auth0 Management API), then retry."
      : "Token may be expired or credentials wrong. Verify the secret in AWS Secrets Manager (platform-mcp/auth0/management-creds).";
    throw new Auth0Error(
      err("auth_failed", `${resp.status}: ${detail}`, hint),
    );
  }
  throw new Auth0Error(
    err(
      "api_error",
      `${resp.status} from ${url}: ${truncate(resp.text)}`,
      "Unexpected Auth0 API error.",
    ),
  );
}

function truncate(s: string, max = 500): string {
  return s.length <= max ? s : s.slice(0, max);
}
