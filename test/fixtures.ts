import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type {
  Caller,
  RegistryItem,
  UserPermissions,
  AuditRecord,
} from "../src/types.js";
import { setAuditSink } from "../src/audit.js";
import { setPermissionsStore } from "../src/user-permissions-store.js";
import { setRegistryStore, _invalidateCacheForTesting } from "../src/registry.js";
import {
  setDispatcherForTesting,
  type LambdaDirectDispatcher,
  type LambdaDirectDispatchInput,
  type LambdaDirectDispatchResult,
} from "../src/lambda-direct-dispatcher.js";

export function buildCaller(overrides: Partial<Caller> = {}): Caller {
  return {
    user_email: "alice@linq.com",
    caller_arn:
      "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_PlatformMcpUser_a1b2c3/alice@linq.com",
    account_id: "111111111111",
    permission_set_name: "PlatformMcpUser",
    ...overrides,
  };
}

export function buildPermissions(
  overrides: Partial<UserPermissions> = {},
): UserPermissions {
  return {
    user_email: "alice@linq.com",
    permissions: new Set(["erp:user:read"]),
    last_modified_at: "2026-05-06T00:00:00Z",
    ...overrides,
  };
}

export function buildRegistryItem(
  overrides: Partial<RegistryItem> = {},
): RegistryItem {
  return {
    toolId: "erp_checkUserAccess",
    version: "1.0.0",
    status: "active",
    description: "Check ERP user access for a tenant.",
    title: "ERP Check User Access",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    requiredPermissions: ["erp:user:read"],
    dispatchTarget: {
      kind: "https-jwt",
      url: "https://abc123.execute-api.us-east-1.amazonaws.com/prod/erp/checkUserAccess",
      tokenSecretArn:
        "arn:aws:secretsmanager:us-east-1:111111111111:secret:platform-mcp/erp/jwt-creds",
      scope: "linq-erp-mcp/erp.invoke",
    },
    ...overrides,
  };
}

export function buildPlatformWhoamiItem(): RegistryItem {
  return buildRegistryItem({
    toolId: "platform_whoami",
    description: "Identity echo.",
    title: "Whoami",
    requiredPermissions: [],
    dispatchTarget: { kind: "inline" },
  });
}

export function buildPlatformListProductsItem(): RegistryItem {
  return buildRegistryItem({
    toolId: "platform_list_products",
    description: "List visible product namespaces.",
    requiredPermissions: [],
    dispatchTarget: { kind: "inline" },
  });
}

export function buildPlatformSearchToolsItem(): RegistryItem {
  return buildRegistryItem({
    toolId: "platform_search_tools",
    description: "Search the tool registry by regex.",
    requiredPermissions: [],
    dispatchTarget: { kind: "inline" },
  });
}

export function buildEvent(
  overrides: Partial<APIGatewayProxyEventV2> = {},
  callerArn = "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_PlatformMcpUser_a1b2c3/alice@linq.com",
): APIGatewayProxyEventV2 {
  // The `requestContext.authorizer.iam` field for AWS_IAM auth on HTTP API v2
  // is real at runtime but not in `@types/aws-lambda` — cast through unknown.
  const requestContext = {
    accountId: "111111111111",
    apiId: "abc123",
    domainName: "abc123.execute-api.us-east-1.amazonaws.com",
    domainPrefix: "abc123",
    authorizer: { iam: { userArn: callerArn, accountId: "111111111111" } },
    http: {
      method: "POST",
      path: "/jsonrpc",
      protocol: "HTTP/1.1",
      sourceIp: "127.0.0.1",
      userAgent: "test",
    },
    requestId: "req-test",
    routeKey: "POST /jsonrpc",
    stage: "$default",
    time: "2026-05-06T00:00:00Z",
    timeEpoch: 1746489600000,
  };
  return {
    version: "2.0",
    routeKey: "POST /jsonrpc",
    rawPath: "/jsonrpc",
    rawQueryString: "",
    headers: { "content-type": "application/json" },
    requestContext: requestContext as unknown as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ...overrides,
  };
}

export function captureAudit(): { records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  setAuditSink({
    async emit(record): Promise<void> {
      records.push(record);
    },
  });
  return { records };
}

export function installPermissionsStore(
  rows: Record<string, UserPermissions | undefined>,
): void {
  setPermissionsStore({
    async load(email: string): Promise<UserPermissions | undefined> {
      return rows[email];
    },
  });
}

export function installRegistryStore(items: RegistryItem[]): void {
  _invalidateCacheForTesting();
  setRegistryStore({
    async listAll(): Promise<RegistryItem[]> {
      return items;
    },
  });
}

/**
 * Inject a fake `lambda-direct` dispatcher and capture the last input it
 * received. Returns the captured-input ref so tests can assert on the
 * payload shape (e.g., that `action` was added at the top level).
 */
export function installLambdaDirectDispatcher(
  impl: (input: LambdaDirectDispatchInput) => Promise<LambdaDirectDispatchResult>,
): { lastInput?: LambdaDirectDispatchInput } {
  const captured: { lastInput?: LambdaDirectDispatchInput } = {};
  const fake: LambdaDirectDispatcher = {
    async dispatch(input): Promise<LambdaDirectDispatchResult> {
      captured.lastInput = input;
      return impl(input);
    },
  };
  setDispatcherForTesting(fake);
  return captured;
}
