// Extract the caller's identity from an API Gateway event.
//
// Two payload shapes are handled:
//   - HTTP API v2: requestContext.authorizer.iam.userArn
//   - REST API v1: requestContext.identity.userArn (legacy fallback)
//
// For AWS-SSO-issued sessions, the assumed-role ARN takes the shape:
//   arn:aws:sts::ACCOUNT:assumed-role/AWSReservedSSO_PERMSET_xxx/email@linq.com
// The trailing role-session-name is the user's email. The role name carries
// the permission-set name as its second segment (after `AWSReservedSSO_`).

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { Caller } from "./types.js";

interface IamAuthorizerContext {
  userArn?: string;
  accountId?: string;
}

interface IdentityContext {
  userArn?: string | null;
  accountId?: string | null;
}

/**
 * Pull the caller's IAM ARN from either payload format. Returns undefined if
 * the event lacks a recognizable caller — typically because the route was
 * misconfigured without `AWS_IAM` auth.
 */
export function extractCallerArn(
  event: APIGatewayProxyEventV2,
): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = event.requestContext as any;
  const authorizerIam: IamAuthorizerContext | undefined = ctx?.authorizer?.iam;
  if (authorizerIam?.userArn !== undefined && authorizerIam.userArn !== null) {
    return authorizerIam.userArn;
  }
  const identity: IdentityContext | undefined = ctx?.identity;
  if (
    identity?.userArn !== undefined &&
    identity.userArn !== null &&
    identity.userArn !== ""
  ) {
    return identity.userArn;
  }
  return undefined;
}

/**
 * Parse an assumed-role ARN into its three components and the AWS-SSO
 * permission-set name when present.
 */
export function parseAssumedRoleArn(arn: string): {
  account_id: string;
  role_name: string;
  role_session_name: string;
  permission_set_name?: string;
} {
  // arn:aws:sts::ACCOUNT:assumed-role/ROLE_NAME/SESSION_NAME
  const match = /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/(.+)$/.exec(arn);
  if (match === null) {
    throw new Error(`unrecognized assumed-role ARN: ${arn}`);
  }
  const [, accountId, roleName, sessionName] = match;
  let permissionSetName: string | undefined;
  // AWSReservedSSO_<PERMSET_NAME>_<HASH>
  const ssoMatch = /^AWSReservedSSO_(.+)_[a-f0-9]+$/.exec(roleName);
  if (ssoMatch !== null) {
    permissionSetName = ssoMatch[1];
  }
  return {
    account_id: accountId,
    role_name: roleName,
    role_session_name: sessionName,
    permission_set_name: permissionSetName,
  };
}

/**
 * One-shot: pull identity from the API Gateway event and produce the Caller
 * envelope the rest of the server consumes.
 */
export function callerFromEvent(
  event: APIGatewayProxyEventV2,
): Caller | undefined {
  const arn = extractCallerArn(event);
  if (arn === undefined) return undefined;
  const parsed = parseAssumedRoleArn(arn);
  return {
    user_email: parsed.role_session_name,
    caller_arn: arn,
    account_id: parsed.account_id,
    permission_set_name: parsed.permission_set_name,
  };
}
