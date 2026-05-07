import { runSec, classifySubject } from "../src/handlers/sec.js";
import { installFakeFetcher, resetAll } from "./fixtures.js";

afterEach(() => {
  resetAll();
});

describe("sec handler — subject classification", () => {
  it("classifies IPv4", () => {
    expect(classifySubject("1.2.3.4")).toBe("ip");
  });
  it("classifies IPv6", () => {
    expect(classifySubject("::1")).toBe("ip");
  });
  it("classifies email", () => {
    expect(classifySubject("scarver@linq.com")).toBe("email");
  });
  it("classifies user_id", () => {
    expect(classifySubject("auth0|abc")).toBe("user_id");
    expect(classifySubject("google-oauth2|xyz")).toBe("user_id");
  });
  it("classifies policy keyword", () => {
    expect(classifySubject("policy")).toBe("policy");
    expect(classifySubject("config")).toBe("policy");
    expect(classifySubject("settings")).toBe("policy");
  });
  it("classifies status keyword (and empty)", () => {
    expect(classifySubject("status")).toBe("status");
    expect(classifySubject("")).toBe("status");
    expect(classifySubject("posture")).toBe("status");
  });
  it("returns unknown when nothing matches", () => {
    expect(classifySubject("just-some-string")).toBe("unknown");
  });
});

describe("sec handler — dispatch", () => {
  it("returns bad_subject for an unclassifiable subject", async () => {
    installFakeFetcher();
    const r = await runSec("d.auth0.com", "tk", { subject: "weird-thing" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.type).toBe("bad_subject");
  });

  it("policy subject returns three attack-protection sections", async () => {
    const fetcher = installFakeFetcher();
    fetcher.setDefault({ status: 200, body: { enabled: true, mode: "monitor" } });
    const r = await runSec("d.auth0.com", "tk", { subject: "policy" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const data = r.data as {
      subject_kind: string;
      policies: {
        breached_password_detection: unknown;
        brute_force_protection: unknown;
        suspicious_ip_throttling: unknown;
      };
    };
    expect(data.subject_kind).toBe("policy");
    expect(data.policies.breached_password_detection).toBeDefined();
    expect(data.policies.brute_force_protection).toBeDefined();
    expect(data.policies.suspicious_ip_throttling).toBeDefined();
  });

  it("ip subject returns block status (404 = not blocked) and recent activity", async () => {
    const fetcher = installFakeFetcher();
    // anomaly/blocks/ips/<ip> → 404 means "not blocked"
    fetcher.enqueue({
      match: (req) => req.url.includes("anomaly/blocks/ips"),
      status: 404,
      body: {},
    });
    // recent_ip_activity pages /logs at most twice (per_page 100)
    fetcher.setDefault({ status: 200, body: { logs: [], total: 0 } });
    const r = await runSec("d.auth0.com", "tk", { subject: "1.2.3.4", days: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const data = r.data as {
      block: { ip: string; blocked: boolean };
      recent_activity: { events: number };
    };
    expect(data.block).toEqual({ ip: "1.2.3.4", blocked: false });
    expect(data.recent_activity.events).toBe(0);
  });

  it("email subject returns user-blocks lookup", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({
      status: 200,
      body: { blocked_for: [] },
    });
    const r = await runSec("d.auth0.com", "tk", { subject: "scarver@linq.com" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const data = r.data as { subject_kind: string; identifier: string };
    expect(data.subject_kind).toBe("email");
    expect(data.identifier).toBe("scarver@linq.com");
  });

  it("user_id subject returns user-blocks (or user-not-found note)", async () => {
    const fetcher = installFakeFetcher();
    fetcher.enqueue({ status: 404, body: {} });
    const r = await runSec("d.auth0.com", "tk", { subject: "auth0|abc" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const data = r.data as { subject_kind: string; note?: string };
    expect(data.subject_kind).toBe("user_id");
    expect(data.note).toBe("user not found");
  });
});
