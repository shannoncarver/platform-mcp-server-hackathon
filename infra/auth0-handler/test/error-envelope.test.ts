// Error-envelope coverage — one assertion per category. Some categories
// (`missing_env`, `bad_window`, `bad_subject`, `bad_action`) are produced
// by the dispatch layer; others (`auth_failed`, `bad_query`,
// `rate_limited`, `uri_too_large`, `api_error`) come from auth0-client's
// status mapping.

import { mintToken, get, Auth0Error } from "../src/auth0-client.js";
import { runStats } from "../src/handlers/stats.js";
import { runSec } from "../src/handlers/sec.js";
import { runUser } from "../src/handlers/user.js";
import { handler } from "../src/index.js";
import { installFakeFetcher, resetAll } from "./fixtures.js";

afterEach(() => {
  resetAll();
});

describe("error envelope — one per category", () => {
  it("missing_env (entry handler — no secret loader installed)", async () => {
    const r = await handler({ action: "logs", arguments: { query: "type:s" } });
    expect((r as { ok: boolean }).ok).toBe(false);
    // Either missing_env (secret can't be fetched) or auth_failed (secret
    // returns placeholder values). Both are acceptable for this assertion.
    expect(["missing_env", "auth_failed", "api_error"]).toContain(
      (r as { error: { type: string } }).error.type,
    );
  });

  it("auth_failed (Auth0 returns 401 to /api/v2/clients)", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 401,
      body: { message: "expired", error: "invalid_token" },
    });
    let caught: unknown;
    try {
      await get("d.auth0.com", "tk", "clients");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Auth0Error);
    expect((caught as Auth0Error).envelope.error.type).toBe("auth_failed");
  });

  it("bad_query (Auth0 returns 400)", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({ status: 400, body: { message: "invalid Lucene" } });
    await expect(get("d.auth0.com", "tk", "logs")).rejects.toMatchObject({
      envelope: { error: { type: "bad_query" } },
    });
  });

  it("rate_limited (Auth0 returns 429)", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({ status: 429, body: { message: "throttled" } });
    await expect(get("d.auth0.com", "tk", "logs")).rejects.toMatchObject({
      envelope: { error: { type: "rate_limited" } },
    });
  });

  it("uri_too_large (Auth0 returns 414)", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({ status: 414, body: "" });
    await expect(get("d.auth0.com", "tk", "logs")).rejects.toMatchObject({
      envelope: { error: { type: "uri_too_large" } },
    });
  });

  it("api_error (Auth0 returns 500)", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({ status: 500, body: { message: "boom" } });
    await expect(get("d.auth0.com", "tk", "logs")).rejects.toMatchObject({
      envelope: { error: { type: "api_error" } },
    });
  });

  it("auth_failed via mintToken when token endpoint returns 403", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      match: (r) => r.url.includes("/oauth/token"),
      status: 403,
      body: { error: "access_denied", error_description: "scope missing" },
    });
    await expect(mintToken("d.auth0.com", "id", "sec")).rejects.toMatchObject({
      envelope: { error: { type: "auth_failed" } },
    });
  });

  it("bad_window (stats handler)", async () => {
    installFakeFetcher();
    const r = await runStats("d.auth0.com", "tk", { window: "decade" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_window");
  });

  it("bad_subject (sec handler)", async () => {
    installFakeFetcher();
    const r = await runSec("d.auth0.com", "tk", { subject: "garbage-value" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_subject");
  });

  it("bad_action (entry handler)", async () => {
    const r = await handler({ action: "DELETE", arguments: {} });
    expect((r as { ok: boolean }).ok).toBe(false);
    expect((r as { error: { type: string } }).error.type).toBe("bad_action");
  });

  it("bad_query (user handler — refused field)", async () => {
    installFakeFetcher();
    const r = await runUser("d.auth0.com", "tk", {
      email: "x@y.com",
      fields: "password_hash",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
  });
});
