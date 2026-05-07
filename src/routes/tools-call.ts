// tools/call — visibility check, RBAC check, dispatch.
//
// For `inline` tools, dispatch to platform-handlers. Otherwise mint a JWT
// from the registered Cognito token endpoint and POST the body to the
// registered URL with `Authorization: Bearer <jwt>`. Either path emits a
// single audit record per request.

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { Caller, UserPermissions } from "../types.js";
import { getById, isVisibleTo } from "../registry.js";
import {
  rpcError,
  rpcOk,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
} from "../errors.js";
import { dispatch, DispatchError, JwtMintError } from "../jwt-dispatcher.js";
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
  if (item.dispatchTarget.kind === "inline") {
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

  // Cross-account dispatch via OAuth client_credentials JWT + Bearer.
  //
  // Wire shape to handlers:
  //   { caller_email, request_id, arguments }
  //
  // - `caller_email` is metadata: the verified user who initiated the
  //   request. Available for handler-side audit + handler-side scope
  //   decisions (e.g., "can alice ask about bob?"). Never confused with
  //   the operation's own inputs.
  // - `request_id` enables cross-hop tracing.
  // - `arguments` is whatever the user passed in `tools/call.params.arguments`,
  //   verbatim. The handler reads operation inputs (including `tenant_id`,
  //   if the tool accepts one) from here.
  const body = {
    caller_email: args.caller.user_email,
    request_id: args.requestId,
    arguments: args.params.arguments ?? {},
  };

  if (item.dispatchTarget.kind !== "https-jwt") {
    await audit(args, toolName, "deny", "DISPATCH_TARGET_UNKNOWN");
    return rpcError(
      args.rpcId,
      RPC_INTERNAL_ERROR,
      "DISPATCH_TARGET_UNKNOWN",
      args.requestId,
    );
  }

  let dispatchResult;
  try {
    dispatchResult = await dispatch({
      url: item.dispatchTarget.url,
      body,
      tokenSecretArn: item.dispatchTarget.tokenSecretArn,
      scope: item.dispatchTarget.scope,
    });
  } catch (err) {
    if (err instanceof JwtMintError) {
      await audit(args, toolName, "deny", "JWT_MINT_FAILED", err.status, {
        class: "JWT_MINT",
        message: err.message,
      });
      return rpcError(args.rpcId, RPC_INTERNAL_ERROR, "JWT_MINT_FAILED", args.requestId);
    }
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
