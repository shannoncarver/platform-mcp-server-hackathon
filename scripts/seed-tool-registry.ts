// Seed the platform_mcp_tool_registry table with the V1 tools:
//   - platform_whoami         (inline)
//   - platform_list_products  (inline)
//   - platform_search_tools   (inline)
//   - erp_checkUserAccess     (https-jwt → ERP API GW in linq-erp-dev)
//   - platform_auth0_logs     (lambda-direct → auth0-handler-platform-mcp)
//   - platform_auth0_stats    (lambda-direct → auth0-handler-platform-mcp)
//   - platform_auth0_sec      (lambda-direct → auth0-handler-platform-mcp)
//   - platform_auth0_clients  (lambda-direct → auth0-handler-platform-mcp)
//   - platform_auth0_user     (lambda-direct → auth0-handler-platform-mcp)
//
// Tool names use single-underscore namespace separation (e.g.
// `platform_whoami`) instead of dotted form (`platform.whoami`) because
// Anthropic API surfaces validate tool names against
// `^[a-zA-Z0-9_-]{1,64}$`, which forbids the dot character. Claude
// Desktop's chat tab enforces this at submit time and otherwise refuses
// the conversation. Underscores are accepted everywhere.
//
// This script is also a tombstone purger: any registry row whose
// toolId is NOT in the seed list below gets deleted, so renames
// don't leave orphans behind. Idempotent.
//
// Run after all three stacks deploy and `seed-jwt-secret.ts` has populated
// the JWT credentials secret in linq-platform-dev:
//
//   AUTH0_LAMBDA_ARN=arn:aws:lambda:us-east-1:631916786699:function:auth0-handler-platform-mcp \
//   ERP_API_URL=https://abc123.execute-api.us-east-1.amazonaws.com/prod/erp/checkUserAccess \
//   ERP_JWT_SECRET_ARN=arn:aws:secretsmanager:us-east-1:631916786699:secret:platform-mcp/erp/jwt-creds-XXXX \
//   ERP_SCOPE=linq-erp-mcp/erp.invoke \
//   AWS_PROFILE=linq-platform-dev npx tsx scripts/seed-tool-registry.ts

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.TOOL_REGISTRY_TABLE_NAME ?? "platform_mcp_tool_registry";

const ERP_API_URL = process.env.ERP_API_URL;
const ERP_JWT_SECRET_ARN = process.env.ERP_JWT_SECRET_ARN;
const ERP_SCOPE = process.env.ERP_SCOPE ?? "linq-erp-mcp/erp.invoke";
const AUTH0_LAMBDA_ARN = process.env.AUTH0_LAMBDA_ARN;
if (
  ERP_API_URL === undefined ||
  ERP_JWT_SECRET_ARN === undefined ||
  AUTH0_LAMBDA_ARN === undefined
) {
  // eslint-disable-next-line no-console
  console.error(
    "ERP_API_URL, ERP_JWT_SECRET_ARN, and AUTH0_LAMBDA_ARN are required.\n" +
      "  ERP_API_URL          — from erp-handler-platform-mcp (ErpApiUrl output)\n" +
      "  ERP_JWT_SECRET_ARN   — from scripts/seed-jwt-secret.ts (printed on completion)\n" +
      "  AUTH0_LAMBDA_ARN     — from auth0-handler-platform-mcp (Auth0HandlerLambdaArn output)",
  );
  process.exit(2);
}

const NOW = new Date().toISOString();

const tools = [
  {
    toolId: "platform_whoami",
    version: "1.0.0",
    status: "active",
    title: "Identity echo",
    description:
      "Returns the verified user identity, account, scope, and permissions for the current request.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    requiredPermissions: [],
    dispatchTarget: { kind: "inline" },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform_list_products",
    version: "1.0.0",
    status: "active",
    title: "List visible product namespaces",
    description:
      "Lists the LINQ product namespaces the calling user can see, with the count of visible tools per namespace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    requiredPermissions: [],
    dispatchTarget: { kind: "inline" },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform_search_tools",
    version: "1.0.0",
    status: "active",
    title: "Search the tool registry",
    description:
      "Searches the registry for tools whose name or description matches a Python-style regex query. Returns up to 5 tool_reference blocks.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredPermissions: [],
    dispatchTarget: { kind: "inline" },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "erp_checkUserAccess",
    version: "1.0.0",
    status: "active",
    title: "Check ERP user access",
    description:
      "Returns whether a user has access to the LINQ ERP product for a specific tenant. Reads erp_users and erp_tenants and applies the LINQ ERP authorization decision matrix.",
    inputSchema: {
      type: "object",
      properties: {
        user_email: { type: "string", format: "email" },
        tenant_id: { type: "string" },
      },
      required: ["user_email", "tenant_id"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredPermissions: ["erp:user:read"],
    dispatchTarget: {
      kind: "https-jwt",
      url: ERP_API_URL,
      tokenSecretArn: ERP_JWT_SECRET_ARN,
      scope: ERP_SCOPE,
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform_auth0_logs",
    version: "1.0.0",
    status: "active",
    title: "Query Auth0 logs",
    description:
      "Search Auth0 Management API tenant logs by Lucene query OR paginate from a specific log id. Use for: failed-login analysis, brute-force investigation, per-user / per-IP / per-connection event timelines. Returns the raw log objects (untrusted content); the platform's downstream consumers must escape user-controlled fields. Lucene examples: 'type:fp' (failed password), 'type:s AND user_name:\"alice@linq.com\"', 'date:[2026-05-01 TO *]'.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Lucene query string. Pass as-is to Auth0; server validates syntax. Required unless `from_id` is supplied.",
          maxLength: 2000,
        },
        from_id: {
          type: "string",
          description:
            "Checkpoint pagination — start from this log event id. Mutually exclusive with `query`.",
          maxLength: 64,
        },
        max_pages: {
          type: "integer",
          description: "Maximum pages to fetch (default 5, hard max 10).",
          minimum: 1,
          maximum: 10,
          default: 5,
        },
        per_page: {
          type: "integer",
          description: "Results per page (default/max 100).",
          minimum: 1,
          maximum: 100,
          default: 100,
        },
        sort: {
          type: "string",
          description: "Sort spec (default 'date:-1').",
          maxLength: 64,
          default: "date:-1",
        },
        fields: {
          type: "string",
          description: "Comma-separated field projection.",
          maxLength: 1024,
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredPermissions: ["platform:auth0:logs:read"],
    dispatchTarget: {
      kind: "lambda-direct",
      lambdaArn: AUTH0_LAMBDA_ARN,
      action: "logs",
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform_auth0_stats",
    version: "1.0.0",
    status: "active",
    title: "Auth0 tenant stats",
    description:
      "Tenant-wide Auth0 auth health for a relative window: daily login/signup counts, monthly active users, failure breakdown by type, MFA adoption rate, top connections. Use for: weekly health reports, MAU lookups, failure-rate spikes, connection-mix questions.",
    inputSchema: {
      type: "object",
      properties: {
        window: {
          type: "string",
          description:
            "Relative window. Named values OR NNd / NNh form. Default 7d.",
          oneOf: [
            { enum: ["today", "yesterday", "this-week", "24h", "1d", "7d", "14d", "30d", "90d"] },
            { pattern: "^[0-9]{1,3}d$" },
            { pattern: "^[0-9]{1,3}h$" },
          ],
          default: "7d",
        },
        include: {
          type: "string",
          description:
            "Comma-separated subset of: daily, mau, failures, mfa-adoption, top-connections. Mutually exclusive with `exclude`.",
          maxLength: 256,
        },
        exclude: {
          type: "string",
          description:
            "Comma-separated subset to exclude. Mutually exclusive with `include`.",
          maxLength: 256,
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredPermissions: ["platform:auth0:stats:read"],
    dispatchTarget: {
      kind: "lambda-direct",
      lambdaArn: AUTH0_LAMBDA_ARN,
      action: "stats",
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform_auth0_sec",
    version: "1.0.0",
    status: "active",
    title: "Auth0 security inspection",
    description:
      "Inspect Auth0 security state for a specific subject: an IP (block status + recent activity), an email (user blocks lookup), a user_id (auth0|... — block details), or one of 'policy' / 'status' to dump tenant attack-protection policies (breached-password, brute-force, suspicious-IP throttling).",
    inputSchema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "An IP, an email, an auth0|... user_id, or one of 'policy' / 'status'.",
          maxLength: 256,
          default: "status",
        },
        days: {
          type: "integer",
          description:
            "For an IP subject: how far back in /logs to summarize recent activity (default 7, max 90).",
          minimum: 1,
          maximum: 90,
          default: 7,
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredPermissions: ["platform:auth0:sec:read"],
    dispatchTarget: {
      kind: "lambda-direct",
      lambdaArn: AUTH0_LAMBDA_ARN,
      action: "sec",
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform_auth0_clients",
    version: "1.0.0",
    status: "active",
    title: "List/get Auth0 applications",
    description:
      "List or fetch Auth0 application (client) configuration. Use for: 'show me the ERP V4 callback URLs', 'is this app first-party', 'what grant types does X allow'. Read-only; client_secret, signing_keys, and encryption_key are never returned (refused even if explicitly requested).",
    inputSchema: {
      type: "object",
      properties: {
        client_id: {
          type: "string",
          description: "Fetch a single client by client_id.",
          maxLength: 128,
        },
        name: {
          type: "string",
          description:
            "Case-insensitive substring filter on client name. Server-fetches all and filters client-side.",
          maxLength: 256,
        },
        app_type: {
          type: "string",
          description: "Server-side filter.",
          enum: ["spa", "regular_web", "native", "non_interactive"],
        },
        is_first_party: {
          type: "boolean",
          description: "Server-side filter.",
        },
        fields: {
          type: "string",
          description:
            "Comma-separated projection (defaults to a verification-relevant set). client_secret / signing_keys / encryption_key are always rejected.",
          maxLength: 1024,
        },
        per_page: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 50,
        },
        max_pages: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredPermissions: ["platform:auth0:clients:read"],
    dispatchTarget: {
      kind: "lambda-direct",
      lambdaArn: AUTH0_LAMBDA_ARN,
      action: "clients",
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform_auth0_user",
    version: "1.0.0",
    status: "active",
    title: "Get Auth0 user record",
    description:
      "Fetch a specific Auth0 user by email or user_id. Use for: 'is this user set up correctly', 'when did this user last sign in', 'what identities are linked'. Read-only; password_hash, phone_password_hash, last_password_reset, and guardian_authenticators are never returned (refused even if explicitly requested).",
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          format: "email",
          description: "Email lookup via /api/v2/users-by-email.",
        },
        user_id: {
          type: "string",
          description:
            "User-id lookup via /api/v2/users/{id}. e.g. 'auth0|abc123'.",
          maxLength: 256,
        },
        fields: {
          type: "string",
          description:
            "Comma-separated projection. password_hash and credential fields are always rejected.",
          maxLength: 1024,
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredPermissions: ["platform:auth0:user:read"],
    dispatchTarget: {
      kind: "lambda-direct",
      lambdaArn: AUTH0_LAMBDA_ARN,
      action: "user",
    },
    createdAt: NOW,
    updatedAt: NOW,
  },
];

async function main(): Promise<void> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  // Purge tombstones — any row whose toolId is not in the seed list. This
  // keeps the registry consistent across rename migrations.
  const desiredIds = new Set(tools.map((t) => t.toolId));
  const scanResult = await ddb.send(
    new ScanCommand({ TableName: TABLE, ProjectionExpression: "toolId" }),
  );
  const orphans = (scanResult.Items ?? [])
    .map((it) => it.toolId as string)
    .filter((id) => !desiredIds.has(id));
  for (const id of orphans) {
    // eslint-disable-next-line no-console
    console.log(`Purging orphan: ${id}`);
    await ddb.send(
      new DeleteCommand({ TableName: TABLE, Key: { toolId: id } }),
    );
  }

  for (const tool of tools) {
    // eslint-disable-next-line no-console
    console.log(`Seeding ${TABLE}: ${tool.toolId} (${tool.version})`);
    await ddb.send(new PutCommand({ TableName: TABLE, Item: tool }));
  }
  // eslint-disable-next-line no-console
  console.log(
    `Done. ${tools.length} tools seeded; ${orphans.length} orphan(s) purged.`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
