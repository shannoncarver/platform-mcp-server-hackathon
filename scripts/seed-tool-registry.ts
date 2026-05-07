// Seed the platform_mcp_tool_registry table with the four V1 tools:
//   - platform_whoami         (inline)
//   - platform_list_products  (inline)
//   - platform_search_tools   (inline)
//   - erp_checkUserAccess     (https-jwt → ERP API GW in linq-erp-dev)
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
// Run after both stacks deploy and `seed-jwt-secret.ts` has populated the
// JWT credentials secret in linq-platform-dev:
//
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
if (ERP_API_URL === undefined || ERP_JWT_SECRET_ARN === undefined) {
  // eslint-disable-next-line no-console
  console.error(
    "ERP_API_URL and ERP_JWT_SECRET_ARN are required. Get the URL from the\n" +
      "erp-handler-platform-mcp stack (ErpApiUrl output) and the secret ARN\n" +
      "from `scripts/seed-jwt-secret.ts`'s output (which prints it after\n" +
      "writing the secret).",
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
