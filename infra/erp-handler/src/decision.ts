// erp.checkUserAccess — decision logic.
//
// The handler reads three DynamoDB rows and runs a deterministic decision
// over them:
//
//   1. user-in-tenant row: erp_users[pk=user_email, sk=tenant_id]
//   2. superuser row:      erp_users[pk=user_email, sk="SUPERUSER"]
//   3. tenant row:         erp_tenants[pk=tenant_id]
//
// The decision tree mirrors the LINQ ERP HarmonyAuthAuthorize endpoint,
// preserving two intentional behaviors:
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

export interface UserRow {
  pk: string;
  sk: string;
  is_active: boolean;
  roles?: string[];
}

export interface TenantRow {
  pk: string;
  is_active: boolean;
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

export function decide(input: DecisionInput): DecisionResult {
  const { user_in_tenant, superuser, tenant } = input;

  // B1 — an inactive superuser row blocks all access, even if a valid
  // user-in-tenant row exists.
  if (superuser !== undefined && superuser.is_active === false) {
    return {
      authorized: false,
      status: "SUPERUSER_DISABLED",
      reason: "superuser row exists and is_active=false",
      matched_user_record: "superuser",
    };
  }

  // B2 — an inactive tenant row blocks access. A missing tenant row does NOT.
  if (tenant !== undefined && tenant.is_active === false) {
    return {
      authorized: false,
      status: "TENANT_DISABLED",
      reason: "tenant row exists and is_active=false",
      matched_user_record:
        superuser !== undefined && superuser.is_active === true
          ? "superuser"
          : user_in_tenant !== undefined
            ? "user_in_tenant"
            : "none",
    };
  }

  // Active superuser — authorize.
  if (superuser !== undefined && superuser.is_active === true) {
    if (tenant === undefined) {
      // Tenant row missing; superuser is still authorized.
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

  // No superuser — fall through to the user-in-tenant row.
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

  if (user_in_tenant.is_active === false) {
    return {
      authorized: false,
      status: "USER_DISABLED",
      reason: "user-in-tenant row exists and is_active=false",
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
