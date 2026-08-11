/**
 * Audit emitter: writes append-only app.audit_logs rows inside the mutation's own transaction.
 *
 * The caller wraps its mutation in withTenantTx (which sets the PostgreSQL session GUCs for
 * school_id, user_id, request_id) and calls emitAuditLog after the mutation succeeds.
 * If emitAuditLog throws, the transaction rolls back, taking the mutation with it -- the
 * two are atomic.
 *
 * auditAction() is a Hono middleware that declares intent: it stores the audit action and
 * target table in the request context for downstream consumers and for the CI coverage check
 * (tests/audit-coverage.test.ts), which greps route files for mutating routes without a
 * corresponding auditAction declaration.
 */

import type { MiddlewareHandler } from "hono";
import type { JSONValue, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Audit action -- mirrors the app.audit_action PostgreSQL enum. */
export type AuditAction =
  "insert" | "update" | "delete" | "login" | "logout" | "export" | "permission_change" | "read";

/** Fields whose values must never appear in audit payloads. Case-insensitive match. */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "password",
  "password_hash",
  "hashed_password",
  "hashed_pw",
  "token",
  "secret",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "ssn",
  "social_security_number",
  "credit_card",
  "card_number",
  "bank_account",
  "routing_number",
  "national_id",
  "passport_number",
]);

/** One audited event, ready to be written to app.audit_logs. */
export interface AuditEntry {
  action: AuditAction;
  targetTable: string;
  targetId: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  clientIp?: string | null;
  userAgent?: string | null;
}

/** Metadata stored in Hono context by auditAction(). */
export interface AuditMeta {
  action: AuditAction;
  table: string;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Deep-redact sensitive field values from an object destined for audit storage.
 * Matching keys (case-insensitive) are replaced with "[REDACTED]". Nested objects
 * are recursed. Arrays are passed through unchanged -- they contain values, not
 * named fields, and redacting an array element by position would leak the existence
 * of sensitive data at that index.
 */
export function redactPayload(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = "[REDACTED]";
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redactPayload(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit log writer
// ---------------------------------------------------------------------------

/**
 * Insert one app.audit_logs row in the current transaction.
 *
 * Identity columns (school_id, actor_id, request_id) are read from PostgreSQL
 * session GUCs set by withTenantTx -- no application-level identity is passed.
 * On failure this throws, which causes the calling transaction to roll back:
 * the mutation and its audit record are atomic.
 */
export async function emitAuditLog(tx: TransactionSql, entry: AuditEntry): Promise<void> {
  // postgres.js serializes parameters whose inferred PostgreSQL type is jsonb. Passing an already
  // stringified value would therefore encode it a second time and store a JSON string, which the
  // audit table's object-only constraints correctly reject. SQL NULL must stay distinct from the
  // JSON value null for the same reason.
  const oldJson = entry.oldValues != null ? tx.json(entry.oldValues as JSONValue) : null;
  const newJson = entry.newValues != null ? tx.json(entry.newValues as JSONValue) : null;

  await tx`
    INSERT INTO app.audit_logs (
      school_id,
      actor_id,
      action,
      target_table,
      target_id,
      old_values,
      new_values,
      client_ip,
      user_agent,
      request_id
    ) VALUES (
      current_setting('app.school_id', true)::uuid,
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      ${entry.action}::app.audit_action,
      ${entry.targetTable},
      ${entry.targetId}::uuid,
      ${oldJson}::jsonb,
      ${newJson}::jsonb,
      ${entry.clientIp ?? null}::inet,
      ${entry.userAgent ?? null},
      NULLIF(current_setting('app.request_id', true), '')::uuid
    )
  `;
}

// ---------------------------------------------------------------------------
// Route decorator
// ---------------------------------------------------------------------------

/**
 * Hono middleware that declares a route's audit action and target table.
 *
 * This does NOT write audit logs or open transactions -- it is a metadata
 * declaration. The actual audit write happens inside the handler via
 * emitAuditLog(). This middleware exists so that:
 *
 * 1. Downstream middleware or handlers can read c.get("auditMeta").
 * 2. The CI coverage check (tests/audit-coverage.test.ts) can grep for
 *    auditAction( calls to verify every mutating route is covered.
 *
 * @example
 * ```typescript
 * routes.post("/students", auditAction("insert", "students"), handler);
 * routes.put("/students/:id", auditAction("update", "students"), handler);
 * ```
 */
export function auditAction(action: AuditAction, table: string): MiddlewareHandler {
  return async (c, next) => {
    c.set("auditMeta", { action, table } satisfies AuditMeta);
    await next();
  };
}
