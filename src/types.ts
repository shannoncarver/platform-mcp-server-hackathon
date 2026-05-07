// Types shared across the Platform MCP server.
// No runtime behavior lives in this file.

/** A LINQ user, identified by their work email (carried in the AWS SSO role-session-name). */
export interface Caller {
  user_email: string;
  caller_arn: string;
  account_id: string;
  permission_set_name?: string;
}

/** Fine-grained user permissions loaded from DynamoDB. */
export interface UserPermissions {
  user_email: string;
  permissions: Set<string>;
  tenant_id?: string;
  last_modified_at: string;
  last_modified_by?: string;
}

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
  /**
   * Where to dispatch this tool. Two forms:
   *   - `https://...`  — SigV4-signed POST to a per-product API Gateway.
   *   - `inline://`    — handled in-process by `platform-handlers.ts`.
   */
  productApiUrl: string;
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
