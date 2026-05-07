// tools/call — visibility check, RBAC check, dispatch.
//
// For `inline://` tools, dispatch to platform-handlers. Otherwise SigV4-sign
// an HTTPS POST to the registered URL. Either path emits a single audit
// record per request.

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { Caller, UserPermissions } from "../types.js";
import { getById, isVisibleTo } from "../registry.js";
import {
  rpcError,
  rpcOk,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
} from "../errors.js";
import { dispatch, DispatchError } from "../sigv4-dispatcher.js";
import { listProducts, searchTools, whoami } from "../platform-handlers.js";
import { emitAudit } from "../audit.js";

export interface ToolsCallArgs {
  caller: Caller;
  permissions: UserPermissions;
  params: { name?: string; arguments?: Record<string, unknown> };
  rpcId: unknown;
  requestId: string;
  startedAtMs: number;
}

export async function handleToolsCall(
  args: ToolsCallArgs,
): Promise<APIGatewayProxyStructuredResultV2> {
  const toolName = args.params?.name;
  if (typeof toolName !== "string" || toolName.length === 0) {
    return rpcError(
      args.rpcId,
      RPC_INVALID_PARAMS,
      "params.name is required",
      args.requestId,
    );
  }

  const item = await getById(toolName);
  if (item === undefined) {
    await audit(args, toolName, "deny", "TOOL_NOT_FOUND");
    return rpcError(args.rpcId, RPC_INVALID_PARAMS, "TOOL_NOT_FOUND", args.requestId);
  }

  // Visibility check: leaks no metadata about unauthorized tools.
  if (!isVisibleTo(item, args.permissions.permissions)) {
    await audit(args, toolName, "deny", "TOOL_NOT_FOUND");
    return rpcError(args.rpcId, RPC_INVALID_PARAMS, "TOOL_NOT_FOUND", args.requestId);
  }

  // Inline platform.* tools dispatched in-process.
  if (item.productApiUrl === "inline://") {
    let result: unknown;
    try {
      switch (item.toolId) {
        case "platform.whoami":
          result = await whoami(args.caller, args.permissions);
          break;
        case "platform.list_products":
          result = await listProducts(args.permissions);
          break;
        case "platform.search_tools": {
          const argsObj = (args.params.arguments ?? {}) as {
            query?: string;
            limit?: number;
          };
          result = await searchTools(
            argsObj.query ?? "",
            args.permissions,
            argsObj.limit,
          );
          break;
        }
        default:
          await audit(args, toolName, "deny", "INLINE_TOOL_UNKNOWN");
          return rpcError(
            args.rpcId,
            RPC_INTERNAL_ERROR,
            "INLINE_TOOL_UNKNOWN",
            args.requestId,
          );
      }
    } catch (err) {
      await audit(args, toolName, "deny", "INLINE_HANDLER_ERROR", undefined, {
        class: "INLINE",
        message: (err as Error).message,
      });
      return rpcError(args.rpcId, RPC_INTERNAL_ERROR, "INLINE_HANDLER_ERROR", args.requestId);
    }
    await audit(args, toolName, "allow");
    return rpcOk(
      args.rpcId,
      {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      },
      args.requestId,
    );
  }

  // Cross-account dispatch via SigV4.
  const body = {
    user_email: args.caller.user_email,
    tenant_id: args.permissions.tenant_id,
    request_id: args.requestId,
    arguments: args.params.arguments ?? {},
  };

  let dispatchResult;
  try {
    dispatchResult = await dispatch({ url: item.productApiUrl, body });
  } catch (err) {
    if (err instanceof DispatchError) {
      await audit(args, toolName, "deny", `UPSTREAM_${err.status}`, err.status);
      return rpcError(
        args.rpcId,
        RPC_INTERNAL_ERROR,
        `UPSTREAM_${err.status}`,
        args.requestId,
      );
    }
    await audit(args, toolName, "deny", "DISPATCH_ERROR", undefined, {
      class: "DISPATCH",
      message: (err as Error).message,
    });
    return rpcError(args.rpcId, RPC_INTERNAL_ERROR, "DISPATCH_ERROR", args.requestId);
  }

  await audit(
    args,
    toolName,
    "allow",
    undefined,
    dispatchResult.status,
  );
  return rpcOk(
    args.rpcId,
    {
      content: [{ type: "text", text: JSON.stringify(dispatchResult.body) }],
      structuredContent: dispatchResult.body,
    },
    args.requestId,
  );
}

async function audit(
  args: ToolsCallArgs,
  toolId: string,
  decision: "allow" | "deny",
  denial_reason?: string,
  outbound_status?: number,
  error?: { class: string; message: string },
): Promise<void> {
  await emitAudit({
    request_id: args.requestId,
    ts: new Date().toISOString(),
    caller_email: args.caller.user_email,
    caller_arn: args.caller.caller_arn,
    method: "tools/call",
    tool_id: toolId,
    decision,
    denial_reason,
    outbound_status,
    latency_ms: Date.now() - args.startedAtMs,
    error,
  });
}
