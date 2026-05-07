import { handleToolsCall } from "../src/routes/tools-call.js";
import {
  buildCaller,
  buildPermissions,
  buildPlatformListProductsItem,
  buildPlatformSearchToolsItem,
  buildPlatformWhoamiItem,
  buildRegistryItem,
  captureAudit,
  installRegistryStore,
} from "./fixtures.js";

describe("handleToolsCall — visibility / RBAC", () => {
  it("returns TOOL_NOT_FOUND when the tool id is unknown", async () => {
    installRegistryStore([buildRegistryItem({ toolId: "erp_x" })]);
    captureAudit();
    const result = await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions(),
      params: { name: "missing_tool" },
      rpcId: 1,
      requestId: "req-1",
      startedAtMs: Date.now(),
    });
    const body = JSON.parse(result.body as string);
    expect(body.error.message).toBe("TOOL_NOT_FOUND");
  });

  it("returns TOOL_NOT_FOUND when the user lacks the required permission (no metadata leak)", async () => {
    installRegistryStore([
      buildRegistryItem({
        toolId: "erp_checkUserAccess",
        requiredPermissions: ["erp:user:read"],
      }),
    ]);
    captureAudit();
    const result = await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions({ permissions: new Set() }), // no perms
      params: { name: "erp_checkUserAccess" },
      rpcId: 1,
      requestId: "req-1",
      startedAtMs: Date.now(),
    });
    const body = JSON.parse(result.body as string);
    expect(body.error.message).toBe("TOOL_NOT_FOUND");
  });
});

describe("handleToolsCall — inline platform handlers", () => {
  it("dispatches platform_whoami in-process and returns caller info", async () => {
    installRegistryStore([buildPlatformWhoamiItem()]);
    captureAudit();
    const result = await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions(),
      params: { name: "platform_whoami" },
      rpcId: 1,
      requestId: "req-1",
      startedAtMs: Date.now(),
    });
    const body = JSON.parse(result.body as string);
    expect(body.result.structuredContent.email).toBe("alice@linq.com");
  });

  it("dispatches platform_list_products and groups by namespace", async () => {
    installRegistryStore([
      buildPlatformListProductsItem(),
      buildRegistryItem({ toolId: "erp_a", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "erp_b", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "crm_a", requiredPermissions: [] }),
    ]);
    captureAudit();
    const result = await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions({ permissions: new Set() }),
      params: { name: "platform_list_products" },
      rpcId: 1,
      requestId: "req-1",
      startedAtMs: Date.now(),
    });
    const body = JSON.parse(result.body as string);
    const products = body.result.structuredContent.products;
    const namespaces = products.map((p: { namespace: string }) => p.namespace).sort();
    expect(namespaces).toEqual(["crm", "erp"]);
  });

  it("dispatches platform_search_tools and returns tool_reference[] for matches", async () => {
    installRegistryStore([
      buildPlatformSearchToolsItem(),
      buildRegistryItem({ toolId: "erp_a", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "erp_b", requiredPermissions: [] }),
    ]);
    captureAudit();
    const result = await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions({ permissions: new Set() }),
      params: { name: "platform_search_tools", arguments: { query: "^erp_" } },
      rpcId: 1,
      requestId: "req-1",
      startedAtMs: Date.now(),
    });
    const body = JSON.parse(result.body as string);
    const refs =
      body.result.structuredContent.content[0].tool_search_tool_search_result
        .tool_references;
    expect(refs.map((r: { tool_name: string }) => r.tool_name).sort()).toEqual([
      "erp_a",
      "erp_b",
    ]);
  });
});

describe("handleToolsCall — audit", () => {
  it("emits an allow record on a successful inline call", async () => {
    installRegistryStore([buildPlatformWhoamiItem()]);
    const audit = captureAudit();
    await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions(),
      params: { name: "platform_whoami" },
      rpcId: 1,
      requestId: "req-allow",
      startedAtMs: Date.now() - 5,
    });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0].decision).toBe("allow");
    expect(audit.records[0].tool_id).toBe("platform_whoami");
    expect(audit.records[0].caller_email).toBe("alice@linq.com");
  });

  it("emits a deny record when the tool is not visible", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "erp_x", requiredPermissions: ["nope"] }),
    ]);
    const audit = captureAudit();
    await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions({ permissions: new Set() }),
      params: { name: "erp_x" },
      rpcId: 1,
      requestId: "req-deny",
      startedAtMs: Date.now(),
    });
    expect(audit.records[0].decision).toBe("deny");
    expect(audit.records[0].denial_reason).toBe("TOOL_NOT_FOUND");
  });
});
