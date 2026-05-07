// Error envelope shared by every handler. Categories mirror the Python
// auth0-management skill's `_auth0_common.py` so LLM consumers see a
// stable error vocabulary regardless of which dispatch path delivered it.

/** Envelope shape returned to the platform on failure. */
export interface ErrorEnvelope {
  ok: false;
  error: { type: ErrorType; detail: string; hint: string };
}

/** Envelope shape returned to the platform on success. */
export interface SuccessEnvelope<T = unknown> {
  ok: true;
  data: T;
}

/** Discriminated-union helper. The Lambda always returns one of these. */
export type HandlerResult<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

/**
 * Error categories. Mirrors the Python skill's exit-code categories:
 *
 *   missing_env   — required env / secret value absent
 *   auth_failed   — Auth0 returned 401 or 403
 *   bad_query     — invalid query / Lucene syntax / refused field
 *   rate_limited  — 429 even after one retry
 *   api_error     — any other Auth0 API failure
 *   uri_too_large — 414 (query string exceeds server limit)
 *   bad_window    — invalid `--window` value (stats handler)
 *   bad_subject   — could not classify a sec subject
 *   bad_action    — top-level `action` did not match a known handler
 */
export type ErrorType =
  | "missing_env"
  | "auth_failed"
  | "bad_query"
  | "rate_limited"
  | "api_error"
  | "uri_too_large"
  | "bad_window"
  | "bad_subject"
  | "bad_action";

export function err(type: ErrorType, detail: string, hint: string): ErrorEnvelope {
  return { ok: false, error: { type, detail, hint } };
}

export function ok<T>(data: T): SuccessEnvelope<T> {
  return { ok: true, data };
}
