// Cross-account dispatcher — OAuth 2.0 client_credentials JWT + Bearer token.
//
// Replaces the SigV4 dispatcher. Wire-shape:
//   1. Load JWT credentials from Secrets Manager (cached).
//   2. Mint an access token from the Cognito token endpoint via
//      client_credentials grant (cached until expiry - margin).
//   3. POST the request body to the per-product API Gateway URL with
//      `Authorization: Bearer <jwt>`.
//
// SCP-safe: no cross-account IAM action. Both the token-endpoint call and
// the API GW call are public HTTPS.

import * as https from "node:https";
import { URLSearchParams } from "node:url";
import { loadJwtCredentials } from "./secrets-store.js";

export interface JwtDispatchInput {
  url: string;
  body: Record<string, unknown>;
  tokenSecretArn: string;
  scope: string;
  timeoutMs?: number;
}

export interface JwtDispatchResult {
  status: number;
  body: unknown;
}

export class DispatchError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
    message: string,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

export class JwtMintError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string,
    message: string,
  ) {
    super(message);
    this.name = "JwtMintError";
  }
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

// Per-cold-container cache, keyed by `secretArn|scope`. Lambda warm
// invocations re-use the token; cold invocations refetch.
const tokenCache = new Map<string, CachedToken>();
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Test-only: clear the JWT cache between cases. */
export function _resetTokenCacheForTesting(): void {
  tokenCache.clear();
}

async function mintToken(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  scope: string,
  timeoutMs: number,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const url = new URL(tokenEndpoint);
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    scope,
  }).toString();
  // Cognito accepts client creds either in Basic auth header or in the
  // form body. Basic is more common; we use that.
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + (url.search ?? ""),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${basicAuth}`,
          "content-length": Buffer.byteLength(form).toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(
              new JwtMintError(
                status,
                text,
                `cognito token endpoint returned ${status}`,
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(text) as {
              access_token?: string;
              expires_in?: number;
            };
            if (
              parsed.access_token === undefined ||
              parsed.expires_in === undefined
            ) {
              reject(
                new JwtMintError(
                  status,
                  text,
                  "cognito response missing access_token or expires_in",
                ),
              );
              return;
            }
            resolve({
              accessToken: parsed.access_token,
              expiresInSec: parsed.expires_in,
            });
          } catch (err) {
            reject(
              new JwtMintError(
                status,
                text,
                `cognito response parse error: ${(err as Error).message}`,
              ),
            );
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("cognito token request timed out"));
    });
    req.on("error", reject);
    req.write(form);
    req.end();
  });
}

async function getOrMintToken(
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  scope: string,
  cacheKey: string,
  timeoutMs: number,
): Promise<string> {
  const nowMs = Date.now();
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAtMs - REFRESH_MARGIN_MS > nowMs) {
    return cached.accessToken;
  }
  const minted = await mintToken(
    tokenEndpoint,
    clientId,
    clientSecret,
    scope,
    timeoutMs,
  );
  const expiresAtMs = nowMs + minted.expiresInSec * 1000;
  tokenCache.set(cacheKey, {
    accessToken: minted.accessToken,
    expiresAtMs,
  });
  return minted.accessToken;
}

/**
 * Mint a JWT (cached), then POST `body` to `url` with
 * `Authorization: Bearer <jwt>`.
 */
export async function dispatch(
  input: JwtDispatchInput,
): Promise<JwtDispatchResult> {
  const creds = await loadJwtCredentials(input.tokenSecretArn);
  const cacheKey = `${input.tokenSecretArn}|${input.scope}`;
  const timeoutMs = input.timeoutMs ?? 15_000;

  const token = await getOrMintToken(
    creds.token_endpoint,
    creds.client_id,
    creds.client_secret,
    input.scope,
    cacheKey,
    timeoutMs,
  );

  const url = new URL(input.url);
  const bodyString = JSON.stringify(input.body);

  return await new Promise<JwtDispatchResult>((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + (url.search ?? ""),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "content-length": Buffer.byteLength(bodyString).toString(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            // eslint-disable-next-line no-console
            console.error(
              JSON.stringify({
                kind: "jwt_dispatch_non_2xx",
                url: input.url,
                status,
                response_body: text.slice(0, 1024),
              }),
            );
            reject(
              new DispatchError(
                status,
                text,
                `dispatch returned non-2xx: ${status}`,
              ),
            );
            return;
          }
          let parsed: unknown;
          try {
            parsed = text.length > 0 ? JSON.parse(text) : {};
          } catch {
            parsed = text;
          }
          resolve({ status, body: parsed });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("dispatch timeout"));
    });
    req.on("error", reject);
    req.write(bodyString);
    req.end();
  });
}
