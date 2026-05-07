// erp.checkUserAccess Lambda — runs in the linq-erp-dev account, fronted
// by API Gateway REST v1 with AWS_IAM auth + a resource policy listing the
// Platform MCP Lambda role ARN as the only allowed principal.
//
// Trust model: the request body is trusted because the SigV4 signature
// (validated by API Gateway) proves it originated from the Platform MCP
// role. The handler does NOT validate JWTs; it does NOT re-authenticate
// the user.
//
// Wire shape from the platform:
//   { caller_email, request_id, arguments: { user_email, tenant_id } }
//
// - `caller_email` is the human who initiated the request (metadata).
// - `arguments.user_email` is the SUBJECT — the user we're checking.
// - `arguments.tenant_id` is the tenant to check the subject against.
//
// The platform has no concept of tenant; tenant scope (if any) is
// the handler's concern.

import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { decide, type TenantRow, type UserRow } from "./decision.js";

const ERP_USERS_TABLE = process.env.ERP_USERS_TABLE_NAME ?? "erp_users";
const ERP_TENANTS_TABLE =
  process.env.ERP_TENANTS_TABLE_NAME ?? "erp_tenants";
const SUPERUSER_SK_VALUE = process.env.ERP_SUPERUSER_SK ?? "SUPERUSER";

let docClient: DynamoDBDocumentClient | undefined;

function getClient(): DynamoDBDocumentClient {
  if (docClient === undefined) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return docClient;
}

interface ToolArguments {
  user_email?: unknown;
  tenant_id?: unknown;
}

interface RequestBody {
  caller_email?: unknown;
  request_id?: unknown;
  arguments?: ToolArguments;
}

export interface ErpReader {
  getUserInTenant(
    email: string,
    tenantId: string,
  ): Promise<UserRow | undefined>;
  getSuperuser(email: string): Promise<UserRow | undefined>;
  getTenant(tenantId: string): Promise<TenantRow | undefined>;
}

const ddbReader: ErpReader = {
  async getUserInTenant(email, tenantId): Promise<UserRow | undefined> {
    const result = await getClient().send(
      new GetCommand({
        TableName: ERP_USERS_TABLE,
        Key: { pk: email, sk: tenantId },
      }),
    );
    return result.Item as UserRow | undefined;
  },
  async getSuperuser(email): Promise<UserRow | undefined> {
    const result = await getClient().send(
      new GetCommand({
        TableName: ERP_USERS_TABLE,
        Key: { pk: email, sk: SUPERUSER_SK_VALUE },
      }),
    );
    return result.Item as UserRow | undefined;
  },
  async getTenant(tenantId): Promise<TenantRow | undefined> {
    const result = await getClient().send(
      new GetCommand({
        TableName: ERP_TENANTS_TABLE,
        Key: { pk: tenantId },
      }),
    );
    return result.Item as TenantRow | undefined;
  },
};

let activeReader: ErpReader = ddbReader;

export function setReaderForTesting(reader: ErpReader): void {
  activeReader = reader;
}

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  let body: RequestBody;
  try {
    body = JSON.parse(event.body ?? "{}") as RequestBody;
  } catch {
    return badRequest("invalid JSON body");
  }

  const args = body.arguments ?? {};
  const subjectEmail = args.user_email;
  const tenantId = args.tenant_id;

  if (typeof subjectEmail !== "string" || subjectEmail.length === 0) {
    return badRequest("arguments.user_email is required");
  }
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    return badRequest("arguments.tenant_id is required");
  }

  const requestId =
    typeof body.request_id === "string" ? body.request_id : null;

  try {
    const [user_in_tenant, superuser, tenant] = await Promise.all([
      activeReader.getUserInTenant(subjectEmail, tenantId),
      activeReader.getSuperuser(subjectEmail),
      activeReader.getTenant(tenantId),
    ]);

    const decision = decide({ user_in_tenant, superuser, tenant });

    return ok({
      authorization: {
        authorized: decision.authorized,
        status: decision.status,
        reason: decision.reason,
      },
      subject: { user_email: subjectEmail, tenant_id: tenantId },
      user_in_tenant: user_in_tenant ?? null,
      superuser: superuser ?? null,
      tenant: tenant ?? null,
      matched_user_record: decision.matched_user_record,
      request_id: requestId,
    });
  } catch (err) {
    return ok({
      authorization: {
        authorized: false,
        status: "ERROR",
        reason: (err as Error).message,
      },
      subject: { user_email: subjectEmail, tenant_id: tenantId },
      user_in_tenant: null,
      superuser: null,
      tenant: null,
      matched_user_record: "none",
      request_id: requestId,
    });
  }
}

function ok(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function badRequest(reason: string): APIGatewayProxyResult {
  return {
    statusCode: 400,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: { code: "BAD_REQUEST", message: reason } }),
  };
}
