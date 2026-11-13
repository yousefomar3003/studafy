import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { CreateSchoolEventBody, SchoolEvent, UpdateSchoolEventBody } from "./schemas";
import type { TransactionSql } from "postgres";

interface SchoolEventRow {
  id: string;
  school_id: string;
  created_by: string;
  title: string;
  description: string | null;
  kind: SchoolEvent["kind"];
  starts_on: string;
  ends_on: string;
  created_at: Date;
  updated_at: Date;
}

// `date` columns are cast to text so they come back as the calendar day itself (YYYY-MM-DD) rather
// than as a JS Date at local midnight, which would shift a day across timezones.
const COLUMNS = `
  id, school_id, created_by, title, description, kind,
  starts_on::text AS starts_on, ends_on::text AS ends_on, created_at, updated_at
`;

function toResponse(row: SchoolEventRow): SchoolEvent {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function notFound(): CodedHttpException {
  return new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Calendar event not found");
}

/** Events overlapping [from, to] (both inclusive), in calendar order. */
export async function listSchoolEvents(
  tx: TransactionSql,
  schoolId: string,
  from: string,
  to: string,
): Promise<SchoolEvent[]> {
  const rows = await tx.unsafe<SchoolEventRow[]>(
    `SELECT ${COLUMNS}
       FROM app.school_events
      WHERE school_id = $1::uuid
        AND starts_on <= $3::date
        AND ends_on >= $2::date
      ORDER BY starts_on, ends_on, title, id`,
    [schoolId, from, to],
  );
  return rows.map(toResponse);
}

export async function createSchoolEvent(
  tx: TransactionSql,
  schoolId: string,
  createdBy: string,
  input: CreateSchoolEventBody,
): Promise<SchoolEvent> {
  const [row] = await tx.unsafe<SchoolEventRow[]>(
    `INSERT INTO app.school_events
       (school_id, created_by, title, description, kind, starts_on, ends_on)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date)
     RETURNING ${COLUMNS}`,
    [
      schoolId,
      createdBy,
      input.title,
      input.description ?? null,
      input.kind,
      input.starts_on,
      input.ends_on,
    ],
  );
  if (!row) throw new Error("INSERT INTO app.school_events returned no row");

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "school_events",
    targetId: row.id,
    newValues: {
      title: row.title,
      kind: row.kind,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
    },
  });
  return toResponse(row);
}

export async function updateSchoolEvent(
  tx: TransactionSql,
  schoolId: string,
  eventId: string,
  input: UpdateSchoolEventBody,
): Promise<SchoolEvent> {
  const [existing] = await tx.unsafe<SchoolEventRow[]>(
    `SELECT ${COLUMNS} FROM app.school_events
      WHERE id = $1::uuid AND school_id = $2::uuid
      FOR UPDATE`,
    [eventId, schoolId],
  );
  if (!existing) throw notFound();

  const next = {
    title: input.title ?? existing.title,
    description: input.description === undefined ? existing.description : input.description,
    kind: input.kind ?? existing.kind,
    starts_on: input.starts_on ?? existing.starts_on,
    ends_on: input.ends_on ?? existing.ends_on,
  };
  // The body schema only checks the range when both ends are sent; a one-sided edit is checked here
  // against the stored other end.
  if (next.ends_on < next.starts_on) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "The end date must be on or after the start date",
    );
  }

  const [row] = await tx.unsafe<SchoolEventRow[]>(
    `UPDATE app.school_events
        SET title = $3, description = $4, kind = $5, starts_on = $6::date, ends_on = $7::date,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1::uuid AND school_id = $2::uuid
      RETURNING ${COLUMNS}`,
    [eventId, schoolId, next.title, next.description, next.kind, next.starts_on, next.ends_on],
  );
  if (!row) throw notFound();

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "school_events",
    targetId: eventId,
    oldValues: {
      title: existing.title,
      kind: existing.kind,
      starts_on: existing.starts_on,
      ends_on: existing.ends_on,
    },
    newValues: { title: row.title, kind: row.kind, starts_on: row.starts_on, ends_on: row.ends_on },
  });
  return toResponse(row);
}

export async function deleteSchoolEvent(
  tx: TransactionSql,
  schoolId: string,
  eventId: string,
): Promise<void> {
  const [row] = await tx.unsafe<SchoolEventRow[]>(
    `DELETE FROM app.school_events
      WHERE id = $1::uuid AND school_id = $2::uuid
      RETURNING ${COLUMNS}`,
    [eventId, schoolId],
  );
  if (!row) throw notFound();

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "school_events",
    targetId: eventId,
    oldValues: { title: row.title, kind: row.kind, starts_on: row.starts_on, ends_on: row.ends_on },
  });
}
