// Lambda entry — APIGW v2 event router for the Platform MCP server.
//
// The server speaks JSON-RPC 2.0 over a single HTTP route (typically /jsonrpc).
// API Gateway has already validated the SigV4 signature and admitted the
// caller via AWS_IAM auth by the time we get here.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { randomUUID } from "node:crypto";
import { callerFromEvent } from "./caller-identity.js";
import { loadPermissions } from "./user-permissions-store.js";
import { handleToolsList } from "./routes/tools-list.js";
import { handleToolsCall } from "./routes/tools-call.js";
import {
  rpcError,
  rpcOk,
  unauthorized,
  badRequest,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INTERNAL_ERROR,
} from "./errors.js";
import { emitAudit } from "./audit.js";
import type { JsonRpcRequest } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "linq-platform-mcp";
const SERVER_VERSION = "0.1.0";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const requestId =
    event.headers?.["x-request-id"] ??
    event.requestContext?.requestId ??
    randomUUID();
  const startedAtMs = Date.now();

  const caller = callerFromEvent(event);
  if (caller === undefined) {
    return unauthorized(requestId, "no IAM-authenticated caller in request");
  }

  let rpc: JsonRpcRequest;
  try {
    rpc = JSON.parse(event.body ?? "{}") as JsonRpcRequest;
  } catch {
    return badRequest(requestId, "invalid JSON body");
  }
  if (rpc.jsonrpc !== "2.0") {
    return rpcError(rpc.id, RPC_INVALID_REQUEST, "Invalid JSON-RPC envelope", requestId);
  }

  let permissions;
  try {
    permissions = await loadPermissions(caller.user_email);
  } catch (err) {
    await emitAudit({
      request_id: requestId,
      ts: new Date().toISOString(),
      caller_email: caller.user_email,
      caller_arn: caller.caller_arn,
      method: rpc.method ?? "unknown",
      decision: "deny",
      denial_reason: "PERMISSIONS_LOAD_FAILED",
      latency_ms: Date.now() - startedAtMs,
      error: { class: "DDB", message: (err as Error).message },
    });
    return rpcError(rpc.id, RPC_INTERNAL_ERROR, "permissions load failed", requestId);
  }
  if (permissions === undefined) {
    await emitAudit({
      request_id: requestId,
      ts: new Date().toISOString(),
      caller_email: caller.user_email,
      caller_arn: caller.caller_arn,
      method: rpc.method ?? "unknown",
      decision: "deny",
      denial_reason: "USER_NOT_PROVISIONED",
      latency_ms: Date.now() - startedAtMs,
    });
    return rpcError(rpc.id, RPC_INVALID_REQUEST, "user not provisioned", requestId);
  }

  try {
    switch (rpc.method) {
      case "initialize":
        return rpcOk(
          rpc.id,
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
          requestId,
        );

      case "tools/list": {
        const params = (rpc.params ?? {}) as {
          cursor?: string;
          pageSize?: number;
        };
        return await handleToolsList({
          permissions,
          cursor: params.cursor,
          pageSize: params.pageSize,
          rpcId: rpc.id,
          requestId,
        });
      }

      case "tools/call": {
        const params = (rpc.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        return await handleToolsCall({
          caller,
          permissions,
          params,
          rpcId: rpc.id,
          requestId,
          startedAtMs,
        });
      }

      default:
        return rpcError(
          rpc.id,
          RPC_METHOD_NOT_FOUND,
          `Unknown method: ${rpc.method}`,
          requestId,
        );
    }
  } catch (err) {
    await emitAudit({
      request_id: requestId,
      ts: new Date().toISOString(),
      caller_email: caller.user_email,
      caller_arn: caller.caller_arn,
      method: rpc.method ?? "unknown",
      decision: "deny",
      denial_reason: "UNHANDLED_ERROR",
      latency_ms: Date.now() - startedAtMs,
      error: { class: "INTERNAL", message: (err as Error).message },
    });
    return rpcError(rpc.id, RPC_INTERNAL_ERROR, "internal error", requestId);
  }
}
