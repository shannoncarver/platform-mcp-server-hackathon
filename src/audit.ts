// Single per-request audit emitter.
//
// Lambda's stdout is captured by CloudWatch Logs automatically, so a
// `console.log(JSON.stringify(record))` produces a structured-JSON log line
// that downstream tools (Logs Insights, Firehose → S3) can parse without
// glue code. The emitter is fail-safe: an audit-side error logs to stderr
// but never throws into the caller's request path.

import type { AuditRecord } from "./types.js";

export interface AuditSink {
  emit(record: AuditRecord): Promise<void>;
}

let activeSink: AuditSink = {
  async emit(record: AuditRecord): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
  },
};

export function setAuditSink(sink: AuditSink): void {
  activeSink = sink;
}

export async function emitAudit(record: AuditRecord): Promise<void> {
  try {
    await activeSink.emit(record);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "AUDIT_EMIT_FAILED",
      JSON.stringify({
        request_id: record.request_id,
        error: (err as Error).message,
      }),
    );
  }
}
