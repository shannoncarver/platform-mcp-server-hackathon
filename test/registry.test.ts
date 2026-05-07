import { getById, getProjected, isVisibleTo } from "../src/registry.js";
import { buildRegistryItem, installRegistryStore } from "./fixtures.js";

describe("registry projection", () => {
  it("returns only items whose required permissions are satisfied", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "erp.a", requiredPermissions: ["erp:user:read"] }),
      buildRegistryItem({ toolId: "crm.a", requiredPermissions: ["crm:read"] }),
    ]);
    const projected = await getProjected(new Set(["erp:user:read"]));
    expect(projected.map((i) => i.toolId).sort()).toEqual(["erp.a"]);
  });

  it("filters out non-active items", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "erp.a", status: "deprecated", requiredPermissions: [] }),
      buildRegistryItem({ toolId: "erp.b", status: "active", requiredPermissions: [] }),
    ]);
    const projected = await getProjected(new Set());
    expect(projected.map((i) => i.toolId)).toEqual(["erp.b"]);
  });

  it("returns the full set when permissions are empty and no items require any", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "platform.whoami", requiredPermissions: [] }),
    ]);
    const projected = await getProjected(new Set());
    expect(projected.map((i) => i.toolId)).toEqual(["platform.whoami"]);
  });
});

describe("getById", () => {
  it("returns the matching active item", async () => {
    installRegistryStore([
      buildRegistryItem({ toolId: "erp.a" }),
      buildRegistryItem({ toolId: "erp.b" }),
    ]);
    const item = await getById("erp.b");
    expect(item?.toolId).toBe("erp.b");
  });

  it("returns undefined for an unknown id", async () => {
    installRegistryStore([buildRegistryItem({ toolId: "erp.a" })]);
    expect(await getById("nope")).toBeUndefined();
  });
});

describe("isVisibleTo", () => {
  it("requires every permission in requiredPermissions[]", () => {
    const item = buildRegistryItem({
      requiredPermissions: ["erp:user:read", "platform:catalog:read"],
    });
    expect(isVisibleTo(item, new Set(["erp:user:read"]))).toBe(false);
    expect(
      isVisibleTo(item, new Set(["erp:user:read", "platform:catalog:read"])),
    ).toBe(true);
  });
});
