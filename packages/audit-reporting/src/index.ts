/**
 * Audit explorer: shared filter/cursor/CSV contracts for the audit-log query API and the audit
 * export worker (ST-046x).
 *
 * The API and the workers both run the same SQL against app.audit_logs — the API for paged reads,
 * the worker for the full-range CSV export — so the filter shape, its resolution (bounded
 * created_at range, per the partition-pruning rule in docs/database/audit-logs-data-model.md), the
 * keyset cursor, and the CSV encoding live here, mirroring the @studafy/attendance-reporting
 * split between API and worker.
 *
 * This module is deliberately agnostic to RLS: it never sets session state. Callers open their own
 * tenant transaction (withTenantTx in the API, withSystemTenantTx in the worker) and hand this the
 * transaction handle.
 */

import { z } from "zod";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Mirrors the app.audit_action enum (000018, extended with 'read' by 000098). Kept in the
 * reporting package rather than the API's auditEmitter so the filter schema and the row mapping
 * share one list; the emitter's own AuditAction union is asserted equal to this by contract.
 */
export const AUDIT_ACTIONS = [
  "insert",
  "update",
  "delete",
  "login",
  "logout",
  "export",
  "permission_change",
  "read",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditActionSchema = z.enum(AUDIT_ACTIONS);

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** The audit explorer's filter shape, as a client provides it (wire/JSON keys). */
export interface AuditLogFilterInput {
  from?: string;
  to?: string;
  actorId?: string;
  action?: string;
  targetTable?: string;
  targetId?: string;
}

/** A filter with a fully resolved, bounded created_at range, ready to become WHERE clauses. */
export interface ResolvedAuditLogFilter {
  from: string;
  to: string;
  actorId?: string;
  action?: AuditAction;
  targetTable?: string;
  targetId?: string;
}

/**
 * The default look-back window when the caller names no range. The data model doc recommends
 * `now() - interval '30 days'` as the default for a partition-pruning query.
 */
export const DEFAULT_AUDIT_LOG_RANGE_DAYS = 30;

/**
 * The widest span a single explorer query may cover. Keeps a bounded, prunable range the rule
 * demands and stops a page from scanning years of partitions in one request.
 */
export const MAX_AUDIT_LOG_RANGE_DAYS = 366;

export class AuditLogFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogFilterError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDateTime(value: string, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AuditLogFilterError(`${label} must be a valid ISO-8601 date-time`);
  }
  return date;
}

function optionalUuid(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!UUID_PATTERN.test(value)) {
    throw new AuditLogFilterError(`${label} must be a UUID`);
  }
  return value;
}

/**
 * Resolve a client filter into one with a bounded created_at range. `from`/`to` default to the
 * trailing 30 days, the span is capped at MAX_AUDIT_LOG_RANGE_DAYS, and every optional predicate is
 * validated. Throws AuditLogFilterError on any violation so callers map it to one 400.
 */
export function resolveAuditLogFilter(
  value: AuditLogFilterInput,
  now: Date = new Date(),
): ResolvedAuditLogFilter {
  const to = value.to !== undefined ? parseDateTime(value.to, "to") : now;
  const from =
    value.from !== undefined
      ? parseDateTime(value.from, "from")
      : new Date(now.getTime() - DEFAULT_AUDIT_LOG_RANGE_DAYS * 86_400_000);

  if (from.getTime() > to.getTime()) {
    throw new AuditLogFilterError("from must not be after to");
  }
  const inclusiveDays = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (inclusiveDays > MAX_AUDIT_LOG_RANGE_DAYS) {
    throw new AuditLogFilterError(
      `created_at range must be at most ${MAX_AUDIT_LOG_RANGE_DAYS} days`,
    );
  }

  let action: AuditAction | undefined;
  if (value.action !== undefined) {
    const parsed = auditActionSchema.safeParse(value.action);
    if (!parsed.success) throw new AuditLogFilterError("action is not a known audit action");
    action = parsed.data;
  }

  const targetTable = value.targetTable?.trim();
  if (targetTable !== undefined) {
    if (targetTable === "") throw new AuditLogFilterError("target_table must not be empty");
    if (targetTable.length > 63) throw new AuditLogFilterError("target_table is too long");
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    ...(value.actorId !== undefined ? { actorId: optionalUuid(value.actorId, "actor_id") } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(targetTable !== undefined ? { targetTable } : {}),
    ...(value.targetId !== undefined
      ? { targetId: optionalUuid(value.targetId, "target_id") }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Keyset cursor
// ---------------------------------------------------------------------------

/**
 * Opaque pagination cursor for (created_at, id). A cursor can only be decoded into a position; a
 * caller cannot forge one to skip into another tenant because the position is validated back
 * against the school-scoped, range-bounded query before it is used.
 */
export function encodeAuditCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeAuditCursor(cursor: string): { createdAt: Date; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new AuditLogFilterError("invalid cursor");
  }
  const separator = raw.lastIndexOf("|");
  if (separator <= 0) throw new AuditLogFilterError("invalid cursor");
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!Number.isFinite(createdAt.getTime()) || !UUID_PATTERN.test(id)) {
    throw new AuditLogFilterError("invalid cursor");
  }
  return { createdAt, id };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One audit-log row as the explorer renders it, with the actor's current profile joined in — the
 * join the data model doc endorses for human rendering. `id` and `created_at` together are the
 * physical row identity (the PK); never expose one without the other.
 */
export interface AuditLogEntry {
  id: string;
  created_at: Date;
  action: AuditAction;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  target_table: string;
  target_id: string;
  client_ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

const AUDIT_LOG_SELECT = `
  l.id, l.created_at, l.action::text AS action, l.actor_id,
  concat_ws(' ', u.first_name, u.middle_name, u.last_name) AS actor_name,
  u.email AS actor_email,
  l.target_table, l.target_id, l.client_ip, l.user_agent, l.request_id,
  l.old_values, l.new_values
`;

export interface AuditLogPage {
  items: AuditLogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * One page of the explorer, newest first, keyset-ordered on (created_at, id). The created_at
 * bounds are mandatory predicates — that is what makes partition pruning work (see
 * docs/database/audit-logs-data-model.md) — and a cursor position is always validated to lie inside
 * the resolved range by re-deriving it from the caller's own cursor.
 */
export async function queryAuditLogPage(
  tx: TransactionSql,
  schoolId: string,
  filter: ResolvedAuditLogFilter,
  options: { limit: number; cursor?: string },
): Promise<AuditLogPage> {
  const position = options.cursor !== undefined ? decodeAuditCursor(options.cursor) : null;
  const rows = await tx<AuditLogEntry[]>`
    SELECT ${tx.unsafe(AUDIT_LOG_SELECT)}
    FROM app.audit_logs AS l
    LEFT JOIN app.users AS u
      ON u.id = l.actor_id AND u.school_id = l.school_id
    WHERE l.school_id = ${schoolId}::uuid
      AND l.created_at >= ${filter.from}::timestamptz
      AND l.created_at < ${filter.to}::timestamptz
      AND (${position?.createdAt ?? null}::timestamptz IS NULL
        OR (l.created_at, l.id) < (${position?.createdAt ?? null}::timestamptz, ${position?.id ?? null}::uuid))
      AND (${filter.actorId ?? null}::uuid IS NULL OR l.actor_id = ${filter.actorId ?? null}::uuid)
      AND (${filter.action ?? null} IS NULL OR l.action::text = ${filter.action ?? null})
      AND (${filter.targetTable ?? null} IS NULL OR l.target_table = ${filter.targetTable ?? null})
      AND (${filter.targetId ?? null}::uuid IS NULL OR l.target_id = ${filter.targetId ?? null}::uuid)
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${options.limit + 1}
  `;

  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: last ? encodeAuditCursor(last.created_at, last.id) : null,
  };
}

/**
 * The full result set of an export, oldest first, streamed in batches for bounded memory at
 * 100k-row scale. Each batch is a forward keyset fetch so a query never re-reads the same row, and
 * the cursor stays inside the bounded range for the whole scan.
 */
export async function* queryAuditLogExportRows(
  tx: TransactionSql,
  schoolId: string,
  filter: ResolvedAuditLogFilter,
  batchSize = 10_000,
): AsyncGenerator<AuditLogEntry> {
  let afterCreated: Date | null = null;
  let afterId: string | null = null;
  for (;;) {
    const rows: AuditLogEntry[] = await tx<AuditLogEntry[]>`
      SELECT ${tx.unsafe(AUDIT_LOG_SELECT)}
      FROM app.audit_logs AS l
      LEFT JOIN app.users AS u
        ON u.id = l.actor_id AND u.school_id = l.school_id
      WHERE l.school_id = ${schoolId}::uuid
        AND l.created_at >= ${filter.from}::timestamptz
        AND l.created_at < ${filter.to}::timestamptz
        AND (${afterCreated}::timestamptz IS NULL
          OR (l.created_at, l.id) > (${afterCreated}::timestamptz, ${afterId}::uuid))
        AND (${filter.actorId ?? null}::uuid IS NULL OR l.actor_id = ${filter.actorId ?? null}::uuid)
        AND (${filter.action ?? null} IS NULL OR l.action::text = ${filter.action ?? null})
        AND (${filter.targetTable ?? null} IS NULL OR l.target_table = ${filter.targetTable ?? null})
        AND (${filter.targetId ?? null}::uuid IS NULL OR l.target_id = ${filter.targetId ?? null}::uuid)
      ORDER BY l.created_at ASC, l.id ASC
      LIMIT ${batchSize}
    `;
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    const last = rows.at(-1)!;
    afterCreated = last.created_at;
    afterId = last.id;
    if (rows.length < batchSize) return;
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const AUDIT_LOG_CSV_HEADER = [
  "created_at",
  "action",
  "actor_id",
  "actor_name",
  "actor_email",
  "target_table",
  "target_id",
  "client_ip",
  "user_agent",
  "request_id",
  "old_values",
  "new_values",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One CSV data line (no trailing CRLF) for an audit entry. */
export function auditLogEntryToCsv(row: AuditLogEntry): string {
  const values = [
    row.created_at.toISOString(),
    row.action,
    row.actor_id ?? "",
    row.actor_name ?? "",
    row.actor_email ?? "",
    row.target_table,
    row.target_id,
    row.client_ip ?? "",
    row.user_agent ?? "",
    row.request_id ?? "",
    row.old_values === null ? "" : JSON.stringify(row.old_values),
    row.new_values === null ? "" : JSON.stringify(row.new_values),
  ];
  return values.map(csvCell).join(",");
}

export function auditLogCsvHeader(): string {
  return [...AUDIT_LOG_CSV_HEADER].map(csvCell).join(",");
}

// ---------------------------------------------------------------------------
// Stored export parameters
// ---------------------------------------------------------------------------

/**
 * The resolved filter the API persists into app.audit_export_jobs.parameters at enqueue time, and
 * the worker parses back at claim time. The queue payload deliberately carries no filter — the job
 * row is the source of truth (the same rule the finance export follows), and the schema keeps the
 * two sides from drifting on the stored shape.
 */
export const auditExportParametersSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    actorId: z.string().uuid().optional(),
    action: auditActionSchema.optional(),
    targetTable: z.string().max(63).optional(),
    targetId: z.string().uuid().optional(),
  })
  .strict();

export type AuditExportParameters = z.infer<typeof auditExportParametersSchema>;

// ---------------------------------------------------------------------------
// Job payload
// ---------------------------------------------------------------------------

/**
 * The BullMQ payload the API enqueues for an audit-log export. Carries only the durable job
 * identity (ReportJobContext); the filter lives in the job row's `parameters`, which the store
 * reads at claim time — the same "the queue payload must not be the source of truth" rule the
 * finance export follows.
 */
export const auditExportJobDataSchema = z
  .object({
    version: z.literal(1),
    jobId: z.string().uuid(),
    schoolId: z.string().uuid(),
    requestedByUserId: z.string().uuid(),
  })
  .strict();

export type AuditExportJobData = z.infer<typeof auditExportJobDataSchema>;

export const auditExportFileFormatSchema = z.literal("csv");
export type AuditExportFileFormat = z.infer<typeof auditExportFileFormatSchema>;
