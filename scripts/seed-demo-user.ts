// Insert one row into platform_mcp_user_permissions for the demo user.
//
// Run after the Platform stack is deployed:
//   AWS_PROFILE=linq-platform-dev npx ts-node scripts/seed-demo-user.ts
//
// Override the email or permission list via env vars:
//   DEMO_USER_EMAIL, DEMO_PERMISSIONS (comma-separated)
//
// Note: the platform has no concept of tenant. Permissions are tool-scoped,
// not tenant-scoped. If a user has the permission a tool requires, they can
// invoke that tool for any tenant the tool accepts.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.USER_PERMISSIONS_TABLE_NAME ?? "platform_mcp_user_permissions";
const EMAIL = process.env.DEMO_USER_EMAIL ?? "scarver@linq.com";
// Default permission set covers: ERP user-access checks + all five Auth0
// management actions (logs/stats/sec/clients/user). Override via
// DEMO_PERMISSIONS for narrower test seeds.
const PERMISSIONS = (
  process.env.DEMO_PERMISSIONS ??
  [
    "erp:user:read",
    "platform:auth0:logs:read",
    "platform:auth0:stats:read",
    "platform:auth0:sec:read",
    "platform:auth0:clients:read",
    "platform:auth0:user:read",
  ].join(",")
)
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function main(): Promise<void> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = new Date().toISOString();
  const row = {
    user_email: EMAIL,
    permissions: new Set(PERMISSIONS),
    last_modified_at: now,
    last_modified_by: "scripts/seed-demo-user.ts",
  };
  // eslint-disable-next-line no-console
  console.log(`Seeding ${TABLE}:`, {
    user_email: EMAIL,
    permissions: PERMISSIONS,
  });
  await ddb.send(new PutCommand({ TableName: TABLE, Item: row }));
  // eslint-disable-next-line no-console
  console.log("Done.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
