// Types shared across the Platform MCP server.
// No runtime behavior lives in this file.

/** A LINQ user, identified by their work email (carried in the AWS SSO role-session-name). */
export interface Caller {
  user_email: string;
  caller_arn: string;
  account_id: string;
  permission_set_name?: string;
}

/**
 * Fine-grained user permissions loaded from DynamoDB.
 *
 * The platform has no concept of tenant. A user with permission to invoke a
 * tool can invoke it for any tenant the tool accepts. Tenant scope (if any)
 * is enforced at the handler.
 */
export interface UserPermissions {
  user_email: string;
  permissions: Set<string>;
  last_modified_at: string;
  last_modified_by?: string;
}

/**
 * Where to dispatch a tool. Discriminated union. Three kinds:
 *   - `inline` — handled in-process by `platform-handlers.ts` (whoami,
 *     list_products, search_tools).
 *   - `https-jwt` — public HTTPS POST to a per-product API Gateway with an
 *     OAuth-2.0-client-credentials JWT in the `Authorization` header. The
 *     `tokenSecretArn` points at a Secrets Manager secret in the platform
 *     account holding `{ client_id, client_secret, token_endpoint, scope,
 *     audience }` for that handler. SCP-safe: no cross-account IAM action.
 *   - `lambda-direct` — synchronous AWS Lambda `Invoke` against a Lambda in
 *     the SAME AWS account as the platform. No JWT, no API Gateway. The
 *     called Lambda owns its own credentials (e.g., its own Secrets Manager
 *     secret); the platform dispatcher does not see them. `action` is a
 *     registry-controlled string the platform passes as a top-level field
 *     in the invocation payload so a single Lambda can multiplex multiple
 *     tools (e.g., the Auth0 management Lambda dispatches on `action` to
 *     one of `logs`, `stats`, `sec`, `clients`, `user`).
 *     See `docs/dispatch-patterns.md` for the decision tree.
 */
export type DispatchTarget =
  | { kind: "inline" }
  | {
      kind: "https-jwt";
      url: string;
      tokenSecretArn: string;
      scope: string;
    }
  | {
      kind: "lambda-direct";
      lambdaArn: string;
      action: string;
    };

/** A registry item — one row in `platform_mcp_tool_registry`. */
export interface RegistryItem {
  toolId: string;
  version: string;
  status: "active" | "deprecated" | "retired";
  description: string;
  title?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredPermissions: string[];
  /** Where this tool gets dispatched. */
  dispatchTarget: DispatchTarget;
  createdAt?: string;
  updatedAt?: string;
}

/** What `tools/list` returns for each tool. Mirrors MCP `2025-06-18` shape. */
export interface ToolListEntry {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** A single audit record emitted per request. JSON-serialized to CloudWatch Logs. */
export interface AuditRecord {
  request_id: string;
  ts: string;
  caller_email: string;
  caller_arn: string;
  method: string;
  tool_id?: string;
  decision: "allow" | "deny";
  denial_reason?: string;
  outbound_status?: number;
  latency_ms: number;
  error?: { class: string; message: string };
}

/** JSON-RPC 2.0 request envelope (subset we care about). */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}
