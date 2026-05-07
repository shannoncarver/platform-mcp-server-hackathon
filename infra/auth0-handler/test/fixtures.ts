// Test fixtures for the auth0-handler — fake HTTP fetcher and secret
// loader so the unit tests touch zero network and zero AWS surface.

import {
  setFetcherForTesting,
  _resetFetcherForTesting,
  type HttpFetcher,
  type HttpRequest,
  type HttpResponse,
} from "../src/auth0-client.js";
import {
  setSecretLoaderForTesting,
  _resetSecretLoaderForTesting,
  type Auth0ManagementCreds,
} from "../src/secret-loader.js";

export interface QueuedReply {
  match?: (req: HttpRequest) => boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface FakeFetcherHandle {
  enqueue(reply: QueuedReply): void;
  setDefault(reply: QueuedReply): void;
  requests: HttpRequest[];
}

export function installFakeFetcher(): FakeFetcherHandle {
  const queued: QueuedReply[] = [];
  let defaultReply: QueuedReply | undefined;
  const requests: HttpRequest[] = [];

  const fake: HttpFetcher = {
    async request(req): Promise<HttpResponse> {
      requests.push(req);
      // Pop the first queued reply whose matcher (if any) matches.
      const idx = queued.findIndex((q) => (q.match ?? (() => true))(req));
      if (idx !== -1) {
        const r = queued.splice(idx, 1)[0];
        return toResponse(r);
      }
      if (defaultReply !== undefined) return toResponse(defaultReply);
      throw new Error(`fake fetcher: no reply for ${req.method} ${req.url}`);
    },
  };

  setFetcherForTesting(fake);
  return {
    enqueue(reply): void {
      queued.push(reply);
    },
    setDefault(reply): void {
      defaultReply = reply;
    },
    requests,
  };
}

function toResponse(reply: QueuedReply): HttpResponse {
  return {
    status: reply.status,
    headers: reply.headers ?? {},
    text: typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
  };
}

export function installFakeSecret(creds?: Partial<Auth0ManagementCreds>): void {
  const merged: Auth0ManagementCreds = {
    domain: creds?.domain ?? "linq-accounts-sandbox.us.auth0.com",
    client_id: creds?.client_id ?? "test-client-id",
    client_secret: creds?.client_secret ?? "test-client-secret",
  };
  setSecretLoaderForTesting({ async load() { return merged; } });
}

export function resetAll(): void {
  _resetFetcherForTesting();
  _resetSecretLoaderForTesting();
}

/** Pre-canned token-mint reply — most tests need this enqueued first. */
export const TOKEN_REPLY: QueuedReply = {
  match: (req) => req.url.includes("/oauth/token"),
  status: 200,
  body: { access_token: "test-access-token", token_type: "Bearer", expires_in: 86400 },
};
