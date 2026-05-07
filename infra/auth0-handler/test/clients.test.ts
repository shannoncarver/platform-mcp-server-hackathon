// Field-refusal tests are the most important assertions in this file:
// the skill MUST NOT leak credential material under any circumstance,
// regardless of what `fields` requests.

import { runClients } from "../src/handlers/clients.js";
import { installFakeFetcher, resetAll } from "./fixtures.js";

afterEach(() => {
  resetAll();
});

describe("clients handler", () => {
  it("returns the matched-name subset", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: [
        { client_id: "a", name: "ERP V4 Web" },
        { client_id: "b", name: "ERP V4 Mobile" },
        { client_id: "c", name: "Other App" },
      ],
    });
    const r = await runClients("d.auth0.com", "tk", { name: "ERP" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const data = r.data as { matched: number; clients: Array<{ name: string }> };
    expect(data.matched).toBe(2);
    expect(data.clients.map((c) => c.name).sort()).toEqual([
      "ERP V4 Mobile",
      "ERP V4 Web",
    ]);
  });

  it("REFUSES `fields=client_secret,name` — returns bad_query envelope", async () => {
    installFakeFetcher();
    const r = await runClients("d.auth0.com", "tk", {
      fields: "client_secret,name",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
    expect(r.error.detail).toMatch(/client_secret/);
  });

  it("REFUSES `signing_keys` and `encryption_key` even alongside benign fields", async () => {
    installFakeFetcher();
    const r = await runClients("d.auth0.com", "tk", {
      fields: "name,signing_keys,encryption_key",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
    expect(r.error.detail).toMatch(/signing_keys/);
    expect(r.error.detail).toMatch(/encryption_key/);
  });

  it("strips client_secret defensively if Auth0 ever returns one", async () => {
    // Belt-and-braces: even if Auth0 misbehaves and returns client_secret
    // for a default-projection request, the handler must not include it.
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: [
        {
          client_id: "x",
          name: "Test",
          client_secret: "SECRET-SHOULD-NEVER-LEAK",
          signing_keys: [{ cert: "..." }],
          encryption_key: { kty: "RSA" },
        },
      ],
    });
    const r = await runClients("d.auth0.com", "tk", {});
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const json = JSON.stringify(r.data);
    expect(json).not.toContain("SECRET-SHOULD-NEVER-LEAK");
    expect(json).not.toContain("signing_keys");
    expect(json).not.toContain("encryption_key");
  });

  it("get-by-client-id strips client_secret defensively", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: {
        client_id: "x",
        name: "Test",
        client_secret: "DO-NOT-LEAK",
      },
    });
    const r = await runClients("d.auth0.com", "tk", { client_id: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const json = JSON.stringify(r.data);
    expect(json).not.toContain("DO-NOT-LEAK");
  });
});
