import { handleToolsList } from "../src/routes/tools-list.js";
import {
  buildPermissions,
  buildRegistryItem,
  installRegistryStore,
} from "./fixtures.js";

describe("handleToolsList", () => {
  it("returns the projected catalog ordered by toolId", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "erp.b", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "erp.a", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "erp.c", requiredPermissions: [] }),
    ]);
    const result = await handleToolsList({
      permissions: buildPermissions({ permissions: new Set() }),
      rpcId: 1,
      requestId: "req-1",
    });
    const body = JSON.parse(result.body as string);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "erp.a",
      "erp.b",
      "erp.c",
    ]);
    expect(body.result.nextCursor).toBeUndefined();
  });

  it("paginates through a 100-item registry without duplicates or gaps", async () => {
    const items = [];
    for (let i = 0; i < 100; i++) {
      items.push(
        buildRegistryItem({
          toolId: `erp.tool${String(i).padStart(3, "0")}`,
          requiredPermissions: [],
        }),
      );
    }
    installRegistryStore(items);

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await handleToolsList({
        permissions: buildPermissions({ permissions: new Set() }),
        cursor,
        pageSize: 25,
        rpcId: pages,
        requestId: `req-${pages}`,
      });
      const body = JSON.parse(result.body as string);
      for (const tool of body.result.tools) {
        expect(seen.has(tool.name)).toBe(false);
        seen.add(tool.name);
      }
      cursor = body.result.nextCursor;
      pages++;
    } while (cursor !== undefined);

    expect(pages).toBe(4);
    expect(seen.size).toBe(100);
  });

  it("returns an empty page for an unknown cursor", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "erp.a", requiredPermissions: [] }),
    ]);
    const result = await handleToolsList({
      permissions: buildPermissions({ permissions: new Set() }),
      cursor: Buffer.from("erp.does-not-exist", "utf8").toString("base64"),
      rpcId: 1,
      requestId: "req-unknown",
    });
    const body = JSON.parse(result.body as string);
    expect(body.result.tools).toEqual([]);
  });

  it("filters by user permissions (RBAC negative)", async () => {
    installRegistryStore([
      buildRegistryItem({
        toolId: "erp.checkUserAccess",
        requiredPermissions: ["erp:user:read"],
      }),
      buildRegistryItem({
        toolId: "platform.whoami",
        requiredPermissions: [],
      }),
    ]);
    const result = await handleToolsList({
      permissions: buildPermissions({ permissions: new Set() }), // no perms
      rpcId: 1,
      requestId: "req-rbac",
    });
    const body = JSON.parse(result.body as string);
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "platform.whoami",
    ]);
  });
});
