// erp_checkUserAccess — decision logic.
//
// Mirrors the LINQ ERP HarmonyAuthAuthorize endpoint (and the
// verify-user-authorization skill) and reads three DynamoDB rows:
//
//   1. user-in-tenant row: dev_erp_users[PK="#USRID#<email>", SK="#TEN#<tenant>"]
//   2. superuser row:      dev_erp_users[PK="#USRID#<email>", SK="#TEN#superuser"]
//   3. tenant row:         dev_erp_tenants[PK="#TEN#<tenant>", SK="#TEN#"]
//
// Active-state is encoded as a `status` STRING attribute (case-insensitive
// equality with "active"), not a boolean.
//
// Two intentional behaviors preserved from the C# endpoint:
//
//   B1. A superuser row that exists but is NOT 'active' prevents the
//       user-in-tenant row from ever being consulted.
//   B2. A MISSING tenant row does NOT override authorization. Only an
//       INACTIVE tenant row triggers the override.

export type AuthStatus =
  | "AUTHORIZED_SUPERUSER"
  | "AUTHORIZED_USER"
  | "USER_NOT_FOUND"
  | "USER_DISABLED"
  | "SUPERUSER_DISABLED"
  | "TENANT_DISABLED"
  | "TENANT_MISSING_BUT_USER_AUTHORIZED"
  | "TENANT_MISSING_USER_NOT_AUTHORIZED"
  | "ERROR";

/**
 * A row from `dev_erp_users`. Open shape — we only key on `status`. Any
 * other attributes (PK, SK, user_email, etc.) ride through unchanged.
 */
export interface UserRow {
  status?: string;
  [key: string]: unknown;
}

/** A row from `dev_erp_tenants`. Same open shape; only `status` is decisive. */
export interface TenantRow {
  status?: string;
  [key: string]: unknown;
}

export interface DecisionInput {
  user_in_tenant?: UserRow;
  superuser?: UserRow;
  tenant?: TenantRow;
}

export interface DecisionResult {
  authorized: boolean;
  status: AuthStatus;
  reason: string;
  matched_user_record: "user_in_tenant" | "superuser" | "none";
}

function isActive(row: { status?: string } | undefined): boolean {
  return (
    row !== undefined &&
    typeof row.status === "string" &&
    row.status.trim().toLowerCase() === "active"
  );
}

export function decide(input: DecisionInput): DecisionResult {
  const { user_in_tenant, superuser, tenant } = input;

  // B1 — superuser row exists but is NOT active → blocks all access,
  // even if a valid user-in-tenant row is present.
  if (superuser !== undefined && !isActive(superuser)) {
    return {
      authorized: false,
      status: "SUPERUSER_DISABLED",
      reason: `superuser row exists with status=${JSON.stringify(superuser.status ?? null)}`,
      matched_user_record: "superuser",
    };
  }

  // B2 — inactive tenant row blocks access. A missing tenant row does NOT.
  if (tenant !== undefined && !isActive(tenant)) {
    return {
      authorized: false,
      status: "TENANT_DISABLED",
      reason: `tenant row exists with status=${JSON.stringify(tenant.status ?? null)}`,
      matched_user_record: isActive(superuser)
        ? "superuser"
        : user_in_tenant !== undefined
          ? "user_in_tenant"
          : "none",
    };
  }

  // Active superuser — authorize.
  if (isActive(superuser)) {
    if (tenant === undefined) {
      return {
        authorized: true,
        status: "TENANT_MISSING_BUT_USER_AUTHORIZED",
        reason: "active superuser; tenant row missing (B2)",
        matched_user_record: "superuser",
      };
    }
    return {
      authorized: true,
      status: "AUTHORIZED_SUPERUSER",
      reason: "active superuser",
      matched_user_record: "superuser",
    };
  }

  // No (active) superuser — fall through to the user-in-tenant row.
  if (user_in_tenant === undefined) {
    if (tenant === undefined) {
      return {
        authorized: false,
        status: "TENANT_MISSING_USER_NOT_AUTHORIZED",
        reason: "no superuser, no user-in-tenant row, no tenant row",
        matched_user_record: "none",
      };
    }
    return {
      authorized: false,
      status: "USER_NOT_FOUND",
      reason: "no superuser and no user-in-tenant row",
      matched_user_record: "none",
    };
  }

  if (!isActive(user_in_tenant)) {
    return {
      authorized: false,
      status: "USER_DISABLED",
      reason: `user-in-tenant row exists with status=${JSON.stringify(user_in_tenant.status ?? null)}`,
      matched_user_record: "user_in_tenant",
    };
  }

  if (tenant === undefined) {
    return {
      authorized: true,
      status: "TENANT_MISSING_BUT_USER_AUTHORIZED",
      reason: "active user-in-tenant; tenant row missing (B2)",
      matched_user_record: "user_in_tenant",
    };
  }

  return {
    authorized: true,
    status: "AUTHORIZED_USER",
    reason: "active user-in-tenant; active tenant",
    matched_user_record: "user_in_tenant",
  };
}
