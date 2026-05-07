// Seed the platform_mcp_tool_registry table with the four V1 tools:
//   - platform.whoami         (inline://)
//   - platform.list_products  (inline://)
//   - platform.search_tools   (inline://)
//   - erp.checkUserAccess     (URL of the ERP API Gateway in linq-erp-dev)
//
// Run after both stacks deploy:
//   ERP_API_URL=https://abc123.execute-api.us-east-1.amazonaws.com/prod/erp/checkUserAccess \
//   AWS_PROFILE=linq-platform npx ts-node scripts/seed-tool-registry.ts

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.TOOL_REGISTRY_TABLE_NAME ?? "platform_mcp_tool_registry";

const ERP_API_URL = process.env.ERP_API_URL;
if (ERP_API_URL === undefined) {
  // eslint-disable-next-line no-console
  console.error(
    "ERP_API_URL is required (output ErpApiUrl from the erp-handler stack).",
  );
  process.exit(2);
}

const NOW = new Date().toISOString();

const tools = [
  {
    toolId: "platform.whoami",
    version: "1.0.0",
    status: "active",
    title: "Identity echo",
    description:
      "Returns the verified user identity, account, scope, and permissions for the current request.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    requiredPermissions: [],
    productApiUrl: "inline://",
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform.list_products",
    version: "1.0.0",
    status: "active",
    title: "List visible product namespaces",
    description:
      "Lists the LINQ product namespaces the calling user can see, with the count of visible tools per namespace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
    requiredPermissions: [],
    productApiUrl: "inline://",
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "platform.search_tools",
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
    productApiUrl: "inline://",
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    toolId: "erp.checkUserAccess",
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
    productApiUrl: ERP_API_URL,
    createdAt: NOW,
    updatedAt: NOW,
  },
];

async function main(): Promise<void> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  for (const tool of tools) {
    // eslint-disable-next-line no-console
    console.log(`Seeding ${TABLE}: ${tool.toolId} (${tool.version})`);
    await ddb.send(new PutCommand({ TableName: TABLE, Item: tool }));
  }
  // eslint-disable-next-line no-console
  console.log(`Done. ${tools.length} tools seeded.`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
