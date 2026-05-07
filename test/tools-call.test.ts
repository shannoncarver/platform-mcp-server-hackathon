import { handleToolsCall } from "../src/routes/tools-call.js";
import { LambdaDirectDispatchError } from "../src/lambda-direct-dispatcher.js";
import {
  buildCaller,
  buildPermissions,
  buildPlatformListProductsItem,
  buildPlatformSearchToolsItem,
  buildPlatformWhoamiItem,
  buildRegistryItem,
  captureAudit,
  installLambdaDirectDispatcher,
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

describe("handleToolsCall — lambda-direct dispatch", () => {
  function buildLambdaDirectItem(action: string) {
    return buildRegistryItem({
      toolId: `platform_auth0_${action}`,
      requiredPermissions: [`platform:auth0:${action}:read`],
      dispatchTarget: {
        kind: "lambda-direct",
        lambdaArn:
          "arn:aws:lambda:us-east-1:111111111111:function:auth0-handler-platform-mcp",
        action,
      },
    });
  }

  it("dispatches to the fake adapter and returns the body wrapped in an MCP envelope", async () => {
    installRegistryStore([buildLambdaDirectItem("user")]);
    captureAudit();
    const captured = installLambdaDirectDispatcher(async () => ({
      status: 200,
      body: { ok: true, data: { user_id: "auth0|abc" } },
    }));

    const result = await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions({
        permissions: new Set(["platform:auth0:user:read"]),
      }),
      params: {
        name: "platform_auth0_user",
        arguments: { email: "scarver@linq.com" },
      },
      rpcId: 1,
      requestId: "req-ld-1",
      startedAtMs: Date.now(),
    });

    const body = JSON.parse(result.body as string);
    expect(body.result.structuredContent).toEqual({
      ok: true,
      data: { user_id: "auth0|abc" },
    });

    // The payload received by the adapter has `action` as a top-level field
    // (sourced from the registry, NOT from `arguments`).
    expect(captured.lastInput?.action).toBe("user");
    expect(captured.lastInput?.body.arguments).toEqual({
      email: "scarver@linq.com",
    });
    expect(captured.lastInput?.body.caller_email).toBe("alice@linq.com");
    expect(captured.lastInput?.body.request_id).toBe("req-ld-1");
    // `action` must NOT have been folded into `arguments`. If a user passes
    // `arguments.action = "X"`, the registry-supplied action still wins at
    // the top level — that is the security property we are asserting here.
  });

  it("still surfaces `action` at the top level when the user smuggles `arguments.action`", async () => {
    installRegistryStore([buildLambdaDirectItem("logs")]);
    captureAudit();
    const captured = installLambdaDirectDispatcher(async () => ({
      status: 200,
      body: { ok: true, data: { items: [] } },
    }));

    await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions({
        permissions: new Set(["platform:auth0:logs:read"]),
      }),
      params: {
        name: "platform_auth0_logs",
        arguments: { action: "DELETE_EVERYTHING", query: "type:s" },
      },
      rpcId: 1,
      requestId: "req-ld-smuggle",
      startedAtMs: Date.now(),
    });

    expect(captured.lastInput?.action).toBe("logs");
    // `arguments` is preserved verbatim — the called Lambda branches on
    // top-level `action`, not on `arguments.action`.
    expect(captured.lastInput?.body.arguments).toEqual({
      action: "DELETE_EVERYTHING",
      query: "type:s",
    });
  });

  it("emits an UPSTREAM_5xx audit deny when the dispatcher throws a function error", async () => {
    installRegistryStore([buildLambdaDirectItem("stats")]);
    const audit = captureAudit();
    installLambdaDirectDispatcher(async () => {
      throw new LambdaDirectDispatchError(
        502,
        "{\"errorMessage\":\"unhandled\"}",
        "lambda function error: Unhandled",
      );
    });

    const result = await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions({
        permissions: new Set(["platform:auth0:stats:read"]),
      }),
      params: { name: "platform_auth0_stats", arguments: { window: "7d" } },
      rpcId: 1,
      requestId: "req-ld-err",
      startedAtMs: Date.now(),
    });

    const body = JSON.parse(result.body as string);
    expect(body.error.message).toBe("UPSTREAM_502");
    expect(audit.records[0].decision).toBe("deny");
    expect(audit.records[0].denial_reason).toBe("UPSTREAM_502");
    expect(audit.records[0].outbound_status).toBe(502);
  });

  it("returns TOOL_NOT_FOUND when the user lacks the required permission (visibility leak prevention)", async () => {
    installRegistryStore([buildLambdaDirectItem("clients")]);
    const audit = captureAudit();
    // Install a dispatcher that would EXPLODE if called — proving that
    // visibility check fires before any dispatch.
    installLambdaDirectDispatcher(async () => {
      throw new Error("dispatcher must not be invoked when not visible");
    });

    const result = await handleToolsCall({
      caller: buildCaller(),
      permissions: buildPermissions({ permissions: new Set() }),
      params: { name: "platform_auth0_clients", arguments: {} },
      rpcId: 1,
      requestId: "req-ld-nope",
      startedAtMs: Date.now(),
    });

    const body = JSON.parse(result.body as string);
    expect(body.error.message).toBe("TOOL_NOT_FOUND");
    expect(audit.records[0].denial_reason).toBe("TOOL_NOT_FOUND");
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
