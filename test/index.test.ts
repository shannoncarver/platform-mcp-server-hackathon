import { handler } from "../src/index.js";
import {
  buildEvent,
  buildPermissions,
  buildPlatformWhoamiItem,
  buildRegistryItem,
  captureAudit,
  installPermissionsStore,
  installRegistryStore,
} from "./fixtures.js";

describe("handler — top-level routing", () => {
  beforeEach(() => {
    installPermissionsStore({ "alice@linq.com": buildPermissions() });
    installRegistryStore([
      buildPlatformWhoamiItem(),
      buildRegistryItem({ toolId: "erp_checkUserAccess" }),
    ]);
    captureAudit();
  });

  it("returns 401 when the event has no IAM-authenticated caller", async () => {
    const event = buildEvent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event.requestContext as any).authorizer = undefined;
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  it("returns the initialize handshake on initialize", async () => {
    const event = buildEvent({
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo.name).toBe("linq-platform-mcp");
  });

  it("returns the projected catalog on tools/list", async () => {
    const event = buildEvent({
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const result = await handler(event);
    const body = JSON.parse(result.body as string);
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("returns USER_NOT_PROVISIONED when the user is unknown to the permissions store", async () => {
    installPermissionsStore({}); // empty store
    const event = buildEvent({
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const result = await handler(event);
    const body = JSON.parse(result.body as string);
    expect(body.error.message).toContain("user not provisioned");
  });

  it("returns RPC method-not-found on an unknown method", async () => {
    const event = buildEvent({
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "made/up" }),
    });
    const result = await handler(event);
    const body = JSON.parse(result.body as string);
    expect(body.error.code).toBe(-32601);
  });
});
