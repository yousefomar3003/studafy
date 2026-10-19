/**
 * Structured logging for the workers process.
 *
 * A three-method NDJSON writer, not a logging framework. apps/api has a real one
 * (apps/api/src/logger.ts) but it is not a shared package — docs/architecture/SAD_28_logging_conventions.md
 * names lifting it into packages/ as "the natural follow-up when a second service needs it", and
 * doing that properly is a ticket rather than a side effect of ST-139.
 *
 * What this does adopt from SAD_28 is the wire format: one JSON object per line, `msg` last, and
 * `school_id` / `job_id` as root fields rather than nested. So the lines this emits are queryable
 * alongside the API's without a second parser, and the eventual migration is an import change.
 *
 * Extracted from the copy that was inline in src/index.ts, which is now one of its callers.
 *
 * `warn` and `error` are also forwarded to error monitoring (@studafy/observability's forwardLog:
 * warn → breadcrumb on the current job's scope, error → Sentry event) after the line is written.
 * A no-op without SENTRY_DSN, and never a change to what reaches stdout.
 */
import { forwardLog } from "@studafy/observability";

export interface WorkerLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Serialize a log line.
 *
 * Every dynamic value goes through JSON.stringify, so a message or field value containing a newline
 * cannot forge a second log record — the one raw `\n` is the one the writer appends. Same invariant
 * apps/api/src/logger.ts is built around.
 *
 * An unserializable field (a circular object, a BigInt) must not take down the process that was
 * only trying to describe a failure, so the whole line falls back to a minimal record.
 */
function serialize(level: string, fields: Record<string, unknown>, message: string): string {
  try {
    return JSON.stringify({ level, ...fields, msg: message });
  } catch {
    return JSON.stringify({ level, msg: message, log_serialization_failed: true });
  }
}

export const workerLogger: WorkerLogger = {
  info: (fields, message) => {
    console.log(serialize("info", fields, message));
  },
  warn: (fields, message) => {
    console.warn(serialize("warn", fields, message));
    forwardLog("warn", message, fields);
  },
  error: (fields, message) => {
    console.error(serialize("error", fields, message));
    forwardLog("error", message, fields);
  },
};
