import { runUser } from "../src/handlers/user.js";
import { installFakeFetcher, resetAll } from "./fixtures.js";

afterEach(() => {
  resetAll();
});

describe("user handler", () => {
  it("returns matched users for the email path", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: [
        { user_id: "auth0|abc", email: "scarver@linq.com", name: "Shannon" },
      ],
    });
    const r = await runUser("d.auth0.com", "tk", { email: "Scarver@linq.com" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const data = r.data as { matched: number; lookup: { email: string } };
    expect(data.matched).toBe(1);
    expect(data.lookup.email).toBe("scarver@linq.com");
  });

  it("returns the user object for the user_id path", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: { user_id: "auth0|abc", email: "scarver@linq.com" },
    });
    const r = await runUser("d.auth0.com", "tk", { user_id: "auth0|abc" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const data = r.data as { lookup: { user_id: string }; user: unknown };
    expect(data.lookup.user_id).toBe("auth0|abc");
    expect(data.user).toEqual(
      expect.objectContaining({ user_id: "auth0|abc" }),
    );
  });

  it("returns bad_query when both `email` and `user_id` are passed", async () => {
    installFakeFetcher();
    const r = await runUser("d.auth0.com", "tk", {
      email: "x@y.com",
      user_id: "auth0|abc",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
  });

  it("returns bad_query when neither `email` nor `user_id` is passed", async () => {
    installFakeFetcher();
    const r = await runUser("d.auth0.com", "tk", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
  });

  it("REFUSES `fields=password_hash,email` — returns bad_query envelope", async () => {
    installFakeFetcher();
    const r = await runUser("d.auth0.com", "tk", {
      email: "x@y.com",
      fields: "password_hash,email",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
    expect(r.error.detail).toMatch(/password_hash/);
  });

  it("REFUSES last_password_reset, phone_password_hash, guardian_authenticators", async () => {
    installFakeFetcher();
    const r = await runUser("d.auth0.com", "tk", {
      email: "x@y.com",
      fields: "phone_password_hash,last_password_reset,guardian_authenticators,name",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
    expect(r.error.detail).toMatch(/guardian_authenticators/);
    expect(r.error.detail).toMatch(/phone_password_hash/);
    expect(r.error.detail).toMatch(/last_password_reset/);
  });

  it("strips password_hash defensively if Auth0 returns one anyway", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: [
        {
          user_id: "auth0|abc",
          email: "x@y.com",
          password_hash: "DO-NOT-LEAK",
          phone_password_hash: "ALSO-DO-NOT-LEAK",
          last_password_reset: "2026-05-01",
          guardian_authenticators: [{ id: "g1" }],
        },
      ],
    });
    const r = await runUser("d.auth0.com", "tk", { email: "x@y.com" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const json = JSON.stringify(r.data);
    expect(json).not.toContain("DO-NOT-LEAK");
    expect(json).not.toContain("ALSO-DO-NOT-LEAK");
    expect(json).not.toContain("password_hash");
    expect(json).not.toContain("guardian_authenticators");
    expect(json).not.toContain("last_password_reset");
  });
});
