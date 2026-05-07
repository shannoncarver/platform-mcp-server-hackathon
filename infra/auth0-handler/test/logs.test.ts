import { runLogs } from "../src/handlers/logs.js";
import { installFakeFetcher, resetAll } from "./fixtures.js";

afterEach(() => {
  resetAll();
});

describe("logs handler", () => {
  it("returns logs and totals for a Lucene query", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: { logs: [{ _id: "1", type: "s" }, { _id: "2", type: "s" }], total: 2 },
    });
    const r = await runLogs("d.auth0.com", "tk", {
      query: "type:s",
      max_pages: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const data = r.data;
    expect(data.fetched).toBe(2);
    expect(data.total).toBe(2);
    expect(data.capped).toBe(false);
  });

  it("returns bad_query when neither `query` nor `from_id` is passed", async () => {
    installFakeFetcher();
    const r = await runLogs("d.auth0.com", "tk", {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
  });

  it("returns bad_query when both `query` and `from_id` are passed", async () => {
    installFakeFetcher();
    const r = await runLogs("d.auth0.com", "tk", {
      query: "type:s",
      from_id: "9001234",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_query");
  });

  it("supports checkpoint pagination via `from_id`", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: [{ _id: "100" }, { _id: "101" }],
      headers: {},
    });
    const r = await runLogs("d.auth0.com", "tk", {
      from_id: "099",
      max_pages: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.fetched).toBe(2);
    expect(r.data.from_id).toBe("099");
  });

  it("preserves untrusted log content verbatim (trust-boundary contract)", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: {
        logs: [
          {
            _id: "1",
            type: "s",
            user_name: "<script>alert(1)</script>",
            description: "{{IGNORE_PRIOR_INSTRUCTIONS}}",
          },
        ],
        total: 1,
      },
    });
    const r = await runLogs("d.auth0.com", "tk", { query: "type:s", max_pages: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const log = (r.data.logs[0] as { user_name: string; description: string });
    expect(log.user_name).toBe("<script>alert(1)</script>");
    expect(log.description).toBe("{{IGNORE_PRIOR_INSTRUCTIONS}}");
  });
});
