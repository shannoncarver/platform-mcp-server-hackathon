// In-process handlers for `platform.*` tools.
//
// These never cross account boundaries — they read the verified caller and
// the registry, then return data. Dispatched directly by `routes/tools-call.ts`
// when a tool's `dispatchTarget.kind === "inline"`.

import type { Caller, RegistryItem, UserPermissions } from "./types.js";
import { getProjected } from "./registry.js";

export async function whoami(
  caller: Caller,
  permissions: UserPermissions,
): Promise<unknown> {
  return {
    email: caller.user_email,
    caller_arn: caller.caller_arn,
    account_id: caller.account_id,
    permission_set_name: caller.permission_set_name,
    permissions: Array.from(permissions.permissions),
  };
}

export async function listProducts(
  permissions: UserPermissions,
): Promise<unknown> {
  const projected = await getProjected(permissions.permissions);
  const namespaces = new Map<string, number>();
  for (const item of projected) {
    // Tool IDs use single-underscore namespace separation
    // (e.g. `erp_checkUserAccess`, `platform_whoami`). Anthropic tool-name
    // validation forbids dots, so the first underscore is the separator.
    const ns = item.toolId.split("_")[0];
    if (ns === "platform") continue; // platform isn't a product
    namespaces.set(ns, (namespaces.get(ns) ?? 0) + 1);
  }
  return {
    products: Array.from(namespaces.entries()).map(([namespace, toolCount]) => ({
      namespace,
      toolCount,
    })),
  };
}

export async function searchTools(
  query: string,
  permissions: UserPermissions,
  limit = 5,
): Promise<unknown> {
  if (typeof query !== "string" || query.length === 0) {
    return { content: [{ type: "text", text: JSON.stringify({ tool_references: [] }) }] };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(query);
  } catch {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: { code: "INVALID_PATTERN", query },
            tool_references: [],
          }),
        },
      ],
    };
  }
  const cap = Math.max(1, Math.min(5, limit));
  const projected = await getProjected(permissions.permissions);
  const matches: RegistryItem[] = [];
  for (const item of projected) {
    if (regex.test(item.toolId) || regex.test(item.description)) {
      matches.push(item);
      if (matches.length >= cap) break;
    }
  }
  return {
    content: [
      {
        type: "tool_search_tool_result",
        tool_search_tool_search_result: {
          tool_references: matches.map((m) => ({
            type: "tool_reference",
            tool_name: m.toolId,
          })),
        },
      },
    ],
  };
}
