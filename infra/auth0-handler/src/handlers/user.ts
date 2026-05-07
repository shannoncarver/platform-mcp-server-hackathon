// `platform_auth0_user` handler. Read-only lookup of an Auth0 user by
// email or user_id. The skill REFUSES to project credential material
// (password_hash, phone_password_hash, last_password_reset,
// guardian_authenticators) regardless of `fields` — this is a security
// property, not a usability one. Tested by test/user.test.ts.

import { get } from "../auth0-client.js";
import { err, ok, type HandlerResult } from "../error-envelope.js";

const DEFAULT_USER_FIELDS = [
  "user_id",
  "email",
  "email_verified",
  "blocked",
  "name",
  "nickname",
  "picture",
  "identities",
  "last_login",
  "last_ip",
  "logins_count",
  "created_at",
  "updated_at",
  "app_metadata",
  "user_metadata",
  "given_name",
  "family_name",
];

const FORBIDDEN_USER_FIELDS = new Set([
  "password_hash",
  "phone_password_hash",
  "last_password_reset",
  "guardian_authenticators",
]);

export interface UserArgs {
  email?: unknown;
  user_id?: unknown;
  fields?: unknown;
}

interface ResolvedFields {
  ok: true;
  fields: string;
}
interface RefusedFields {
  ok: false;
  envelope: ReturnType<typeof err>;
}

function resolveFields(requested: unknown): ResolvedFields | RefusedFields {
  const raw =
    typeof requested === "string" && requested.trim().length > 0
      ? requested
      : DEFAULT_USER_FIELDS.join(",");
  const set = new Set(
    raw
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0),
  );
  const refused = [...set].filter((f) => FORBIDDEN_USER_FIELDS.has(f));
  if (refused.length > 0) {
    return {
      ok: false,
      envelope: err(
        "bad_query",
        `Refused fields: ${refused.sort().join(", ")}`,
        "password_hash and credential-related fields are not retrievable via this skill by design. Use the Auth0 Dashboard for credential audit.",
      ),
    };
  }
  for (const f of FORBIDDEN_USER_FIELDS) set.delete(f);
  return { ok: true, fields: [...set].sort().join(",") };
}

export async function runUser(
  domain: string,
  token: string,
  rawArgs: unknown,
): Promise<HandlerResult<unknown>> {
  const args = (rawArgs ?? {}) as UserArgs;
  const email = typeof args.email === "string" && args.email.length > 0 ? args.email : null;
  const userId = typeof args.user_id === "string" && args.user_id.length > 0 ? args.user_id : null;

  if (email === null && userId === null) {
    return err(
      "bad_query",
      "Either `email` or `user_id` is required.",
      "Pass `email` (uses /users-by-email) OR `user_id` (uses /users/{id}).",
    );
  }
  if (email !== null && userId !== null) {
    return err(
      "bad_query",
      "`email` and `user_id` are mutually exclusive.",
      "Pass exactly one of `email` / `user_id`.",
    );
  }

  const resolved = resolveFields(args.fields);
  if (!resolved.ok) return resolved.envelope;

  if (email !== null) {
    const resp = await get<unknown>(domain, token, "users-by-email", {
      email: email.trim().toLowerCase(),
      include_fields: "true",
      fields: resolved.fields,
    });
    const users = Array.isArray(resp.body) ? (resp.body as unknown[]) : [];
    return ok({
      lookup: { email: email.trim().toLowerCase() },
      fields: resolved.fields,
      matched: users.length,
      users: users.map(stripForbidden),
    });
  }

  // user_id path
  const resp = await get<unknown>(
    domain,
    token,
    `users/${encodeURIComponent(userId!)}`,
    { include_fields: "true", fields: resolved.fields },
  );
  return ok({
    lookup: { user_id: userId },
    fields: resolved.fields,
    user: stripForbidden(resp.body),
  });
}

function stripForbidden(body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map(stripForbidden);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (FORBIDDEN_USER_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}
