import { listProducts, searchTools, whoami } from "../src/platform-handlers.js";
import {
  buildCaller,
  buildPermissions,
  buildRegistryItem,
  installRegistryStore,
} from "./fixtures.js";

describe("whoami", () => {
  it("echoes the caller and permissions", async () => {
    const result = (await whoami(
      buildCaller(),
      buildPermissions({ permissions: new Set(["a", "b"]) }),
    )) as Record<string, unknown>;
    expect(result.email).toBe("alice@linq.com");
    expect(result.permission_set_name).toBe("PlatformMcpUser");
    expect((result.permissions as string[]).sort()).toEqual(["a", "b"]);
    // platform_whoami no longer includes tenant_id — the platform has no
    // concept of tenant.
    expect(result.tenant_id).toBeUndefined();
  });
});

describe("listProducts", () => {
  it("groups projected tools by namespace and excludes platform", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "erp_a", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "erp_b", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "crm_a", requiredPermissions: [] }),
      buildRegistryItem({
        toolId: "platform_whoami",
        requiredPermissions: [],
      }),
    ]);
    const result = (await listProducts(
      buildPermissions({ permissions: new Set() }),
    )) as { products: { namespace: string; toolCount: number }[] };
    const sorted = result.products.sort((a, b) =>
      a.namespace.localeCompare(b.namespace),
    );
    expect(sorted).toEqual([
      { namespace: "crm", toolCount: 1 },
      { namespace: "erp", toolCount: 2 },
    ]);
  });
});

describe("searchTools", () => {
  it("regex-matches against the projected catalog", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "erp_checkUserAccess", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "erp_listUsers", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "crm_listAccounts", requiredPermissions: [] }),
    ]);
    const result = (await searchTools(
      "^erp_",
      buildPermissions({ permissions: new Set() }),
    )) as {
      content: {
        tool_search_tool_search_result: {
          tool_references: { tool_name: string }[];
        };
      }[];
    };
    const refs = result.content[0].tool_search_tool_search_result.tool_references;
    expect(refs.map((r) => r.tool_name).sort()).toEqual([
      "erp_checkUserAccess",
      "erp_listUsers",
    ]);
  });

  it("returns an INVALID_PATTERN error block on a malformed regex", async () => {
    installRegistryStore([buildRegistryItem({ requiredPermissions: [] })]);
    const result = (await searchTools(
      "[unclosed",
      buildPermissions({ permissions: new Set() }),
    )) as { content: { type: string; text: string }[] };
    const inner = JSON.parse(result.content[0].text);
    expect(inner.error.code).toBe("INVALID_PATTERN");
  });

  it("returns empty when the user's projection is empty (RBAC negative)", async () => {
    installRegistryStore([
      buildRegistryItem({
        toolId: "erp_x",
        requiredPermissions: ["erp:user:read"],
      }),
    ]);
    const result = (await searchTools(
      ".*",
      buildPermissions({ permissions: new Set() }), // no perms
    )) as {
      content: {
        tool_search_tool_search_result: {
          tool_references: { tool_name: string }[];
        };
      }[];
    };
    const refs = result.content[0].tool_search_tool_search_result.tool_references;
    expect(refs).toEqual([]);
  });
});
