import { runStats } from "../src/handlers/stats.js";
import { installFakeFetcher, resetAll } from "./fixtures.js";

afterEach(() => {
  resetAll();
});

describe("stats handler", () => {
  it("returns mau when include=mau", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      match: (req) => req.url.includes("/api/v2/stats/active-users"),
      status: 200,
      body: 123,
    });
    const r = await runStats("d.auth0.com", "tk", { window: "7d", include: "mau" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.mau).toBe(123);
    expect(r.data.daily).toBeUndefined();
  });

  it("returns bad_window for unrecognized window", async () => {
    installFakeFetcher();
    const r = await runStats("d.auth0.com", "tk", { window: "forever" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_window");
  });

  it("returns bad_query when both include and exclude are set", async () => {
    installFakeFetcher();
    const r = await runStats("d.auth0.com", "tk", {
      window: "7d",
      include: "mau",
      exclude: "daily",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
  });

  it("returns bad_query for unknown include section", async () => {
    installFakeFetcher();
    const r = await runStats("d.auth0.com", "tk", {
      window: "7d",
      include: "not-a-section",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
  });
});
