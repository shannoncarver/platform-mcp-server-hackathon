// tools/list — projected catalog with cursor pagination per MCP 2025-06-18.

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { ToolListEntry, UserPermissions } from "../types.js";
import { getProjected } from "../registry.js";
import { rpcOk } from "../errors.js";

const DEFAULT_PAGE_SIZE = 50;

export interface ToolsListArgs {
  permissions: UserPermissions;
  cursor?: string;
  pageSize?: number;
  rpcId: unknown;
  requestId: string;
}

export async function handleToolsList(
  args: ToolsListArgs,
): Promise<APIGatewayProxyStructuredResultV2> {
  const projected = await getProjected(args.permissions.permissions);
  // Stable, deterministic order — alphabetical by toolId.
  projected.sort((a, b) => a.toolId.localeCompare(b.toolId));

  const pageSize = Math.max(1, args.pageSize ?? DEFAULT_PAGE_SIZE);
  const startIdx = decodeCursor(args.cursor, projected.map((p) => p.toolId));
  const slice = projected.slice(startIdx, startIdx + pageSize);
  const nextIdx = startIdx + slice.length;
  const nextCursor =
    nextIdx < projected.length
      ? encodeCursor(slice[slice.length - 1].toolId)
      : undefined;

  const tools: ToolListEntry[] = slice.map((it) => ({
    name: it.toolId,
    title: it.title,
    description: it.description,
    inputSchema: it.inputSchema,
    outputSchema: it.outputSchema,
  }));

  return rpcOk(
    args.rpcId,
    {
      tools,
      ...(nextCursor !== undefined && { nextCursor }),
    },
    args.requestId,
  );
}

function decodeCursor(
  cursor: string | undefined,
  ids: readonly string[],
): number {
  if (cursor === undefined || cursor === "") return 0;
  let lastSeen: string;
  try {
    lastSeen = Buffer.from(cursor, "base64").toString("utf8");
  } catch {
    return ids.length; // unknown cursor → empty page
  }
  const idx = ids.indexOf(lastSeen);
  if (idx < 0) return ids.length;
  return idx + 1;
}

function encodeCursor(toolId: string): string {
  return Buffer.from(toolId, "utf8").toString("base64");
}
