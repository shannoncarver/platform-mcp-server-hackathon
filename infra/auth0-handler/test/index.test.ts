import { handler } from "../src/index.js";
import { installFakeFetcher, installFakeSecret, resetAll, TOKEN_REPLY } from "./fixtures.js";

afterEach(() => {
  resetAll();
});

describe("auth0-handler entry — action dispatch", () => {
  it("returns bad_action when `action` is missing", async () => {
    const result = await handler({ caller_email: "a@b", request_id: "r1", arguments: {} });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "bad_action" }),
    });
  });

  it("returns bad_action for an unknown action", async () => {
    const result = await handler({ action: "DELETE_EVERYTHING", arguments: {} });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ type: "bad_action" }),
    });
  });

  it("returns missing_env when the secret loader fails (no fake installed)", async () => {
    // No installFakeSecret() — the real loader will try Secrets Manager and
    // fail in the test environment.
    const result = await handler({ action: "logs", arguments: { query: "type:s" } });
    expect((result as { ok: boolean }).ok).toBe(false);
    const errResult = result as { error: { type: string } };
    expect(["missing_env", "auth_failed", "api_error"]).toContain(errResult.error.type);
  });

  it("dispatches action=logs through to the logs handler", async () => {
    installFakeSecret();
    const fetcher = installFakeFetcher();
    fetcher.enqueue(TOKEN_REPLY);
    fetcher.enqueue({
      match: (r) => r.url.includes("/api/v2/logs"),
      status: 200,
      body: { logs: [{ _id: "1", type: "s" }], total: 1 },
    });
    const result = await handler({
      action: "logs",
      arguments: { query: "type:s", max_pages: 1 },
    });
    expect((result as { ok: boolean }).ok).toBe(true);
    const okResult = result as { data: { fetched: number } };
    expect(okResult.data.fetched).toBe(1);
  });

  it("dispatches action=stats through to the stats handler (mau-only minimizes traffic)", async () => {
    installFakeSecret();
    const fetcher = installFakeFetcher();
    fetcher.enqueue(TOKEN_REPLY);
    fetcher.enqueue({
      match: (r) => r.url.includes("/api/v2/stats/active-users"),
      status: 200,
      body: 42,
    });
    const result = await handler({
      action: "stats",
      arguments: { window: "7d", include: "mau" },
    });
    expect((result as { ok: boolean }).ok).toBe(true);
    const okResult = result as { data: { mau: number } };
    expect(okResult.data.mau).toBe(42);
  });

  it("dispatches action=sec with subject=policy", async () => {
    installFakeSecret();
    const fetcher = installFakeFetcher();
    fetcher.enqueue(TOKEN_REPLY);
    fetcher.setDefault({ status: 200, body: { enabled: true } });
    const result = await handler({ action: "sec", arguments: { subject: "policy" } });
    expect((result as { ok: boolean }).ok).toBe(true);
    const okResult = result as { data: { subject_kind: string } };
    expect(okResult.data.subject_kind).toBe("policy");
  });

  it("dispatches action=clients", async () => {
    installFakeSecret();
    const fetcher = installFakeFetcher();
    fetcher.enqueue(TOKEN_REPLY);
    fetcher.enqueue({
      match: (r) => r.url.includes("/api/v2/clients"),
      status: 200,
      body: [{ client_id: "abc", name: "ERP V4" }],
    });
    const result = await handler({ action: "clients", arguments: { name: "ERP" } });
    expect((result as { ok: boolean }).ok).toBe(true);
    const okResult = result as { data: { matched: number } };
    expect(okResult.data.matched).toBe(1);
  });

  it("dispatches action=user with email", async () => {
    installFakeSecret();
    const fetcher = installFakeFetcher();
    fetcher.enqueue(TOKEN_REPLY);
    fetcher.enqueue({
      match: (r) => r.url.includes("/api/v2/users-by-email"),
      status: 200,
      body: [{ user_id: "auth0|abc", email: "scarver@linq.com" }],
    });
    const result = await handler({
      action: "user",
      arguments: { email: "scarver@linq.com" },
    });
    expect((result as { ok: boolean }).ok).toBe(true);
    const okResult = result as { data: { matched: number } };
    expect(okResult.data.matched).toBe(1);
  });
});
