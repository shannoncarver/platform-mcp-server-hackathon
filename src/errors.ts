// JSON-RPC and HTTP error envelope helpers.

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

// JSON-RPC 2.0 standard codes.
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// LINQ-specific codes (the JSON-RPC spec reserves -32000..-32099 for server errors).
export const RPC_AUTHZ_FAILED = -32001;
export const RPC_RATE_LIMITED = -32002;

export function rpcOk(
  rpcId: unknown,
  result: unknown,
  requestId: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, result }),
  };
}

export function rpcError(
  rpcId: unknown,
  code: number,
  message: string,
  requestId: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId ?? null,
      error: { code, message, data: { request_id: requestId } },
    }),
  };
}

export function unauthorized(
  requestId: string,
  reason: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 401,
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({
      error: { code: "UNAUTHORIZED", message: reason, request_id: requestId },
    }),
  };
}

export function badRequest(
  requestId: string,
  reason: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 400,
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({
      error: { code: "BAD_REQUEST", message: reason, request_id: requestId },
    }),
  };
}
