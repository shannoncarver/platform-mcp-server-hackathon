// auth0-handler Lambda — multiplexes five Auth0 management tools behind
// a single `lambda-direct` dispatch from the platform.
//
// Wire shape from the platform:
//   { caller_email, request_id, action, arguments }
//
// `action` is sourced from the registry, NOT from user input; the platform
// guarantees this. We dispatch on it to one of: logs, stats, sec, clients,
// user. Returns a `{ ok: true, data }` envelope on success or
// `{ ok: false, error: { type, detail, hint } }` on failure.
//
// HACKATHON: no token caching — see prompt §2.5; we mint a fresh M2M
// token on every invocation.
//
// Security boundary preserved from the source skill:
//   - clients endpoint never returns client_secret / signing_keys / encryption_key.
//   - user endpoint never returns password_hash / phone_password_hash /
//     last_password_reset / guardian_authenticators.
//   - Log content (user emails, IPs, descriptions, user-agents) is UNTRUSTED
//     and returned as-is. The platform's downstream consumers are
//     responsible for escaping; we do not interpret it as control.

import { mintToken, Auth0Error } from "./auth0-client.js";
import { loadAuth0Creds } from "./secret-loader.js";
import { err, type HandlerResult } from "./error-envelope.js";
import { runLogs } from "./handlers/logs.js";
import { runStats } from "./handlers/stats.js";
import { runSec } from "./handlers/sec.js";
import { runClients } from "./handlers/clients.js";
import { runUser } from "./handlers/user.js";

export interface PlatformInvokeEvent {
  caller_email?: unknown;
  request_id?: unknown;
  action?: unknown;
  arguments?: unknown;
}

export async function handler(
  event: PlatformInvokeEvent,
): Promise<HandlerResult> {
  const action = typeof event.action === "string" ? event.action : "";
  if (action.length === 0) {
    return err(
      "bad_action",
      "Top-level `action` is missing.",
      "The platform must supply `action` (one of: logs, stats, sec, clients, user).",
    );
  }
  if (!["logs", "stats", "sec", "clients", "user"].includes(action)) {
    return err(
      "bad_action",
      `Unknown action: ${JSON.stringify(action)}`,
      "Supported: logs, stats, sec, clients, user.",
    );
  }

  let domain: string;
  let token: string;
  try {
    const creds = await loadAuth0Creds();
    domain = creds.domain;
    // HACKATHON: no token caching — see prompt §2.5
    token = await mintToken(creds.domain, creds.client_id, creds.client_secret);
  } catch (e) {
    if (e instanceof Auth0Error) return e.envelope;
    return err(
      "missing_env",
      `Failed to load Auth0 management credentials: ${(e as Error).message}`,
      "Run scripts/seed-auth0-secret.ts to populate platform-mcp/auth0/management-creds in AWS Secrets Manager.",
    );
  }

  try {
    switch (action) {
      case "logs":
        return await runLogs(domain, token, event.arguments);
      case "stats":
        return await runStats(domain, token, event.arguments);
      case "sec":
        return await runSec(domain, token, event.arguments);
      case "clients":
        return await runClients(domain, token, event.arguments);
      case "user":
        return await runUser(domain, token, event.arguments);
      default:
        return err(
          "bad_action",
          `Unknown action: ${JSON.stringify(action)}`,
          "Supported: logs, stats, sec, clients, user.",
        );
    }
  } catch (e) {
    if (e instanceof Auth0Error) return e.envelope;
    return err(
      "api_error",
      `Unexpected handler error: ${(e as Error).message}`,
      "Re-run; if persistent, check CloudWatch logs for the auth0-handler-platform-mcp Lambda.",
    );
  }
}
