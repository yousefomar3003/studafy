/**
 * Parent digest producer.
 *
 * Runs as a repeatable BullMQ job (JOB_NAMES.SEND_DIGESTS) and collapses the parent-facing
 * outbox events that accumulated since the last run — attendance.alertRaised and
 * fee.installmentOverdue — into one digest.sent event per parent. The email dispatcher then sends
 * each digest through the ordinary channel, so delivery dedup, suppression, and SES correlation
 * apply unchanged.
 *
 * Crash-safety is the same single-transaction trick as the dispatcher: each school's claim,
 * per-parent digest.sent inserts, and dispatched-marking of the claimed rows commit together. A
 * crash rolls the whole school back, so the next run rebuilds the same digests from the same
 * rows; a committed run can never be re-run, because its rows are already marked dispatched.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
import postgres from "postgres";

import { withSystemTenantTx } from "../../../db/tenant-tx";

import { loadSchoolIds } from "./schools";

import type { TransactionSql } from "postgres";

/** The parent-facing events a digest aggregates. Their payload schemas live in apps/api. */
const DIGEST_SOURCE_EVENTS: readonly string[] = [
  DOMAIN_EVENTS.ATTENDANCE_ALERT_RAISED,
  DOMAIN_EVENTS.FEE_INSTALLMENT_OVERDUE,
];

interface ClaimedSourceRow {
  id: string;
  event_name: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * One digest line item. Deliberately a `type` rather than an `interface`: postgres.js's
 * `tx.json()` helper types its argument as an index-signature `JSONValue`, and only type aliases
 * get the implicit index signature TS needs to accept an object here.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- see comment above
type DigestItem = {
  kind: "attendance_alert" | "fee_overdue";
  studentName: string | null;
  text: string;
  occurredAt: string;
};

interface ParentDigest {
  parentUserId: string;
  items: DigestItem[];
}

export interface DigestResult {
  processed: true;
  schoolsScanned: number;
  parentsDigested: number;
  itemsDigested: number;
  sourceEventsClaimed: number;
}

async function loadStudentName(tx: TransactionSql, studentId: string): Promise<string | null> {
  const [row] = await tx<{ full_name: string }[]>`
    SELECT btrim(coalesce(preferred_name, first_name) || ' ' || last_name) AS full_name
    FROM app.students
    WHERE id = ${studentId}::uuid
  `;
  return row?.full_name ?? null;
}

/** Parents linked to a student — the recipient set for fee events, which carry no parent list. */
async function loadLinkedParents(tx: TransactionSql, studentId: string): Promise<string[]> {
  const rows = await tx<{ parent_user_id: string }[]>`
    SELECT parent_user_id
    FROM app.parent_child_links
    WHERE student_id = ${studentId}::uuid
    ORDER BY parent_user_id
  `;
  return rows.map((row) => row.parent_user_id);
}

function formatAmountMinor(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

/**
 * Build the digest items a single source event contributes, keyed by parent. Attendance alerts
 * name their recipients; fee events resolve theirs through the parent-child links.
 */
async function digestItemsFor(tx: TransactionSql, row: ClaimedSourceRow): Promise<ParentDigest[]> {
  const payload = row.payload;
  const studentId = String(payload.studentId);
  const studentName = await loadStudentName(tx, studentId);
  const occurredAt = row.created_at;

  if (row.event_name === DOMAIN_EVENTS.ATTENDANCE_ALERT_RAISED) {
    const absentDays = Number(payload.absentDays);
    const boundaryDate = String(payload.boundaryDate);
    const text =
      payload.ruleType === "period_count"
        ? `${studentName ?? "Your child"} has been absent for ${absentDays} school days recently, as of ${boundaryDate}.`
        : `${studentName ?? "Your child"} has been absent for ${absentDays} consecutive school days, as of ${boundaryDate}.`;

    return (payload.parentUserIds as string[]).map((parentUserId) => ({
      parentUserId,
      items: [{ kind: "attendance_alert" as const, studentName, text, occurredAt }],
    }));
  }

  if (row.event_name === DOMAIN_EVENTS.FEE_INSTALLMENT_OVERDUE) {
    const parentUserIds = await loadLinkedParents(tx, studentId);
    if (parentUserIds.length === 0) return [];

    const dueDate = String(payload.dueDate);
    const text = `A payment of ${formatAmountMinor(Number(payload.outstandingAmountMinor))} for ${studentName ?? "your child"} was due on ${dueDate} and is now overdue.`;

    return parentUserIds.map((parentUserId) => ({
      parentUserId,
      items: [{ kind: "fee_overdue" as const, studentName, text, occurredAt }],
    }));
  }

  return [];
}

async function claimSourceRows(tx: TransactionSql, limit: number): Promise<ClaimedSourceRow[]> {
  return await tx<ClaimedSourceRow[]>`
    SELECT id, event_name, payload, created_at
    FROM app.outbox_events
    WHERE event_name IN ${tx(DIGEST_SOURCE_EVENTS)}
      AND email_dispatched_at IS NULL
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT ${limit}
  `;
}

async function loadParentEmail(tx: TransactionSql, parentUserId: string): Promise<string | null> {
  const [row] = await tx<{ email: string }[]>`
    SELECT email FROM app.users WHERE id = ${parentUserId}::uuid
  `;
  return row?.email ?? null;
}

/**
 * Process one school: claim its undispatched parent-facing events and turn them into per-parent
 * digest.sent outbox events, all in one transaction.
 */
async function processSchool(
  sql: postgres.Sql,
  schoolId: string,
): Promise<{ parents: number; items: number; claimed: number }> {
  return withSystemTenantTx(sql, { schoolId }, async (tx) => {
    const rows = await claimSourceRows(tx, 200);
    if (rows.length === 0) return { parents: 0, items: 0, claimed: 0 };

    // Group by parent across all claimed rows, so one parent gets exactly one digest.
    const byParent = new Map<string, DigestItem[]>();
    for (const row of rows) {
      for (const parentDigest of await digestItemsFor(tx, row)) {
        const existing = byParent.get(parentDigest.parentUserId) ?? [];
        existing.push(...parentDigest.items);
        byParent.set(parentDigest.parentUserId, existing);
      }
    }

    const digestDate = new Date().toISOString().slice(0, 10);
    let parents = 0;
    let items = 0;

    for (const [parentUserId, digestItems] of byParent) {
      const email = await loadParentEmail(tx, parentUserId);
      if (email === null) {
        // A parent with no user row cannot be emailed; their events stay claimed but silent. The
        // in-app notifications they did receive are the record of the alert.
        continue;
      }

      // Hand-built to match eventPayloadSchemas[DIGEST_SENT] in apps/api/src/lib/events/schemas.ts
      // (the contract of record); apps/workers does not depend on apps/api. tx.json() keeps the
      // jsonb an object — see attendance-alert.worker.ts's emitAlertRaised for why that matters.
      const payload = tx.json({
        parentUserId,
        email,
        digestDate,
        items: digestItems,
      });

      await tx`
        INSERT INTO app.outbox_events (school_id, event_name, payload)
        VALUES (${schoolId}::uuid, ${DOMAIN_EVENTS.DIGEST_SENT}, ${payload})
      `;
      parents += 1;
      items += digestItems.length;
    }

    const now = new Date().toISOString();
    await tx`UPDATE app.outbox_events SET email_dispatched_at = ${now} WHERE id = ANY(${rows.map((r) => r.id)})`;

    return { parents, items, claimed: rows.length };
  });
}

/**
 * Run one digest cycle. `databaseUrl` is a parameter rather than read from the environment so the
 * processor is callable from a test against a disposable database — the same shape the attendance
 * alert processor establishes.
 */
export async function processDigest(databaseUrl: string): Promise<DigestResult> {
  const sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });

  try {
    const schoolIds = await loadSchoolIds(sql);

    let parents = 0;
    let items = 0;
    let claimed = 0;

    for (const schoolId of schoolIds) {
      const outcome = await processSchool(sql, schoolId);
      parents += outcome.parents;
      items += outcome.items;
      claimed += outcome.claimed;
    }

    return {
      processed: true,
      schoolsScanned: schoolIds.length,
      parentsDigested: parents,
      itemsDigested: items,
      sourceEventsClaimed: claimed,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
