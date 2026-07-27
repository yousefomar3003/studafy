import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emit } from "../../../lib/events/emitter";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { AssignmentFilterStatus, AssignmentStatus } from "./schemas";
import type { TransactionSql } from "postgres";

/**
 * Assignment persistence and authorization (ST-103).
 *
 * ## Where authorization actually lives
 *
 * Three layers, each doing something the others cannot:
 *
 * 1. `tenant_isolation` (000006) pins every row to app.school_id. Nothing here can cross a school.
 * 2. `role_scope_visibility` on app.assignments (000037) restricts SELECT to
 *    app.can_read_class(class_id) -- admin, the class's teacher, an enrolled student, or a linked
 *    parent. This is the reason the read queries below carry no tenant predicate of their own.
 * 3. This module, for the two things RLS does not express.
 *
 * The two gaps are worth naming, because both are silent:
 *
 * - `app.can_read_class` accepts ANY enrollment row, including a withdrawn one. A student who left
 *   a class in September would keep seeing its coursework all year.
 * - The policy has no status predicate, so a draft assignment -- a teacher's unfinished work -- is
 *   readable by every enrolled student the moment the row exists.
 *
 * VISIBILITY_PREDICATE below closes both. It is layered on top of RLS, not a replacement for it:
 * remove the policy and this still refuses to show a student another class's work; remove this and
 * the policy still refuses to show them another school's.
 *
 * ## Writes
 *
 * `role_scope_visibility` is SELECT-only by design (000037's header says so explicitly), so
 * create/update/delete scope is enforced here via assertCanManageClass, which asks the same
 * SECURITY DEFINER helper the policy uses rather than reimplementing "teaches this class" in
 * TypeScript. One definition, two callers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssignmentRow {
  id: string;
  school_id: string;
  class_id: string;
  subject_id: string;
  /** Resolved through the class. Not projected onto responses -- it exists for event payloads. */
  course_id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  status: AssignmentStatus;
  available_from: Date | null;
  assigned_at: Date | null;
  due_at: Date;
  /**
   * PostgreSQL numeric arrives from postgres.js as a string -- the driver will not silently narrow
   * an arbitrary-precision type to an IEEE double. Kept as string here and converted once, at the
   * response boundary, so the conversion is visible rather than implied.
   */
  max_score: string;
  allow_late_submission: boolean;
  created_by_user_id: string;
  last_edited_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface ListAssignmentsParams {
  limit: number;
  cursor?: string;
  class_id?: string;
  subject_id?: string;
  status?: AssignmentFilterStatus;
}

export interface CreateAssignmentParams {
  class_id: string;
  title: string;
  description?: string;
  instructions?: string;
  available_from?: string;
  due_at: string;
  max_score: number;
  allow_late_submission: boolean;
  status: Exclude<AssignmentStatus, "archived">;
}

export interface UpdateAssignmentParams {
  title?: string;
  description?: string | null;
  instructions?: string | null;
  available_from?: string | null;
  due_at?: string;
  max_score?: number;
  allow_late_submission?: boolean;
  status?: AssignmentStatus;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Refuse unless the caller may manage assignments for this class.
 *
 * Delegates to the same SECURITY DEFINER helpers the RLS policies call, so "teaches this class"
 * has exactly one definition in the system. app.teaches_class covers both the lead teacher and any
 * teacher holding a timetable slot for the class, which is what makes a co-teacher or a substitute
 * work without a second membership table.
 *
 * 403 rather than 404 is correct here even though it confirms the class exists: the caller has
 * already passed the ASSIGNMENT_* permission gate, so they are staff, and a teacher who mistypes a
 * class id is far better served by "not your class" than by "no such class".
 */
export async function assertCanManageClass(tx: TransactionSql, classId: string): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT (app.current_user_is_school_admin() OR app.teaches_class(${classId})) AS allowed
  `;

  if (!row?.allowed) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.ASSIGNMENT_CLASS_FORBIDDEN,
      "You are not assigned to this class",
    );
  }
}

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

/**
 * Row visibility, layered on the RLS policy. See the module header for why both exist.
 *
 * Staff (admin or a teacher of the class) see every status including drafts. Everyone else sees
 * only non-draft assignments for a class they are ACTIVELY enrolled in -- `e.status = 'active'` is
 * the whole difference from app.can_read_class, and it is why a withdrawn student's list goes
 * empty rather than staying populated.
 *
 * Parents are intentionally not granted a branch here. They can read assignments through the RLS
 * policy, but the enrollment-status tightening this ticket asks for is specified for students; a
 * parent view scoped to their child's active enrollments is its own piece of work.
 */
function visibilityPredicate(tx: TransactionSql) {
  return tx`
    AND (
      app.current_user_is_school_admin()
      OR app.teaches_class(a.class_id)
      OR (
        a.status <> 'draft'
        AND EXISTS (
          SELECT 1
          FROM app.enrollments AS e
          JOIN app.students AS s ON s.id = e.student_id AND s.school_id = e.school_id
          WHERE e.class_id = a.class_id
            AND e.school_id = a.school_id
            AND e.status = 'active'
            AND s.user_id = app.scope_user_id()
        )
      )
    )
  `;
}

/** Every assignment column plus the subject resolved through the class's course. */
function selectColumns(tx: TransactionSql) {
  return tx`
    a.id, a.school_id, a.class_id, co.subject_id, cl.course_id,
    a.title, a.description, a.instructions, a.status,
    a.available_from, a.assigned_at, a.due_at, a.max_score, a.allow_late_submission,
    a.created_by_user_id, a.last_edited_by_user_id, a.created_at, a.updated_at
  `;
}

/**
 * The class -> course join, present on every read.
 *
 * It exists to project subject_id, which is not a column on app.assignments: a class already
 * resolves to a subject through its course, and duplicating it onto the assignment would create
 * two answers to one question. Both joins are inner and pin school_id, so they cannot widen the
 * result set or reach across a tenant.
 */
function subjectJoin(tx: TransactionSql) {
  return tx`
    JOIN app.classes AS cl ON cl.id = a.class_id AND cl.school_id = a.school_id
    JOIN app.courses AS co ON co.id = cl.course_id AND co.school_id = a.school_id
  `;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * Keyset cursor over (due_at, id), encoded as "<iso timestamp>:<uuid>".
 *
 * The id tiebreaker is not optional: due_at is not unique -- a teacher setting five assignments to
 * the same Friday deadline is the normal case, not an edge one -- and a cursor on a non-unique key
 * alone either skips rows or repeats them at every page boundary.
 *
 * Split on the LAST colon because the timestamp contains colons and the uuid does not.
 */
function decodeCursor(cursor: string): { dueAt: string; id: string } {
  const separator = cursor.lastIndexOf(":");
  if (separator <= 0) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Malformed pagination cursor");
  }

  const dueAt = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);

  if (!dueAt || !id) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Malformed pagination cursor");
  }

  return { dueAt, id };
}

function encodeCursor(row: AssignmentRow): string {
  return `${row.due_at.toISOString()}:${row.id}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listAssignments(
  tx: TransactionSql,
  schoolId: string,
  params: ListAssignmentsParams,
): Promise<{ rows: AssignmentRow[]; next_cursor: string | null }> {
  // Over-fetch by one to learn whether another page exists, rather than issuing a second COUNT
  // that would have to re-evaluate the same scope predicates.
  const fetchLimit = params.limit + 1;

  const cursorFilter = params.cursor
    ? (() => {
        const { dueAt, id } = decodeCursor(params.cursor);
        return tx` AND (a.due_at, a.id) < (${dueAt}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const classFilter = params.class_id ? tx` AND a.class_id = ${params.class_id}` : tx``;
  const subjectFilter = params.subject_id ? tx` AND co.subject_id = ${params.subject_id}` : tx``;

  const statusFilter = (() => {
    switch (params.status) {
      case "upcoming":
        return tx` AND a.due_at > CURRENT_TIMESTAMP`;
      case "past_due":
        return tx` AND a.due_at <= CURRENT_TIMESTAMP`;
      case "submitted":
        // Scoped to the CALLING user's own student row, not to "any submission exists". A teacher
        // filtering by submitted would otherwise see every assignment anyone had handed in, which
        // is a different question from the one this filter names.
        return tx`
          AND EXISTS (
            SELECT 1
            FROM app.assignment_submissions AS sub
            JOIN app.students AS st ON st.id = sub.student_id AND st.school_id = sub.school_id
            WHERE sub.assignment_id = a.id
              AND sub.school_id = a.school_id
              AND st.user_id = app.scope_user_id()
              AND sub.status IN ('submitted', 'late', 'graded', 'returned')
          )
        `;
      default:
        return tx``;
    }
  })();

  const rows = await tx<AssignmentRow[]>`
    SELECT ${selectColumns(tx)}
    FROM app.assignments AS a
    ${subjectJoin(tx)}
    WHERE a.school_id = ${schoolId}
      ${visibilityPredicate(tx)}
      ${classFilter}
      ${subjectFilter}
      ${statusFilter}
      ${cursorFilter}
    ORDER BY a.due_at DESC, a.id DESC
    LIMIT ${fetchLimit}
  `;

  const hasMore = rows.length === fetchLimit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page.at(-1);

  return { rows: page, next_cursor: hasMore && last ? encodeCursor(last) : null };
}

export async function getAssignment(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
): Promise<AssignmentRow | null> {
  const [row] = await tx<AssignmentRow[]>`
    SELECT ${selectColumns(tx)}
    FROM app.assignments AS a
    ${subjectJoin(tx)}
    WHERE a.school_id = ${schoolId}
      AND a.id = ${assignmentId}
      ${visibilityPredicate(tx)}
  `;

  return row ?? null;
}

/**
 * Fetch by id ignoring the read-visibility predicate, for mutation paths.
 *
 * A teacher editing their own draft must be able to load it, and a draft is invisible to the
 * student-facing predicate by design. Callers of this MUST have already passed
 * assertCanManageClass; it is named "forUpdate" rather than "unchecked" because that ordering is
 * the contract, not a suggestion. RLS still applies, so this cannot reach another school.
 */
async function getAssignmentForUpdate(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
): Promise<AssignmentRow | null> {
  const [row] = await tx<AssignmentRow[]>`
    SELECT ${selectColumns(tx)}
    FROM app.assignments AS a
    ${subjectJoin(tx)}
    WHERE a.school_id = ${schoolId} AND a.id = ${assignmentId}
    FOR UPDATE OF a
  `;

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Fields worth recording in an audit diff. Timestamps and identity columns are noise there. */
function auditableFields(row: AssignmentRow): Record<string, unknown> {
  return {
    class_id: row.class_id,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    status: row.status,
    available_from: row.available_from?.toISOString() ?? null,
    due_at: row.due_at.toISOString(),
    max_score: row.max_score,
    allow_late_submission: row.allow_late_submission,
  };
}

export async function createAssignment(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: CreateAssignmentParams,
): Promise<AssignmentRow> {
  await assertCanManageClass(tx, params.class_id);

  // ck_assignments_lifecycle requires assigned_at to be NULL for a draft and NOT NULL otherwise,
  // so publishing and stamping the time are the same operation, not two.
  const assignedAt = params.status === "draft" ? null : new Date().toISOString();

  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.assignments (
      school_id, class_id, created_by_user_id, last_edited_by_user_id,
      title, description, instructions, status,
      available_from, assigned_at, due_at, max_score, allow_late_submission
    ) VALUES (
      ${schoolId}, ${params.class_id}, ${userId}, ${userId},
      ${params.title}, ${params.description ?? null}, ${params.instructions ?? null},
      ${params.status}::app.assignment_status,
      ${params.available_from ?? null}::timestamptz,
      ${assignedAt}::timestamptz,
      ${params.due_at}::timestamptz,
      ${params.max_score},
      ${params.allow_late_submission}
    )
    RETURNING id
  `;

  const row = await getAssignmentForUpdate(tx, schoolId, inserted!.id);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "assignments",
    targetId: row!.id,
    newValues: auditableFields(row!),
  });

  if (row!.status === "published") {
    await emit(tx, DOMAIN_EVENTS.ASSIGNMENT_PUBLISHED, {
      assignmentId: row!.id,
      courseId: row!.course_id,
    });
  }

  return row!;
}

export async function updateAssignment(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  assignmentId: string,
  params: UpdateAssignmentParams,
): Promise<AssignmentRow> {
  // Load first: the class the assignment belongs to is what determines who may edit it, and that
  // is a property of the stored row, not of the request body.
  const existing = await getAssignmentForUpdate(tx, schoolId, assignmentId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Assignment not found");
  }

  await assertCanManageClass(tx, existing.class_id);

  const nextStatus = params.status ?? existing.status;
  const publishing = existing.status === "draft" && nextStatus !== "draft";
  const unpublishing = existing.status !== "draft" && nextStatus === "draft";

  if (unpublishing) {
    // ck_assignments_lifecycle would reject the row anyway (a draft must have a NULL assigned_at,
    // and clearing it would erase when the work was actually set). Refusing here makes it a named
    // 409 instead of a constraint violation surfacing as a 500.
    throw new CodedHttpException(
      409,
      ERROR_CODES.ASSIGNMENT_INVALID_STATUS_TRANSITION,
      "An assignment cannot return to draft once it has been published",
    );
  }

  // The date pair can straddle the body and the stored row -- a PATCH may move only one end of it.
  // Validating the merged values is the only way to catch that; the schema-level refinement only
  // sees what was sent.
  const mergedAvailableFrom =
    params.available_from === undefined
      ? (existing.available_from?.toISOString() ?? null)
      : params.available_from;
  const mergedDueAt = params.due_at ?? existing.due_at.toISOString();

  if (mergedAvailableFrom && mergedAvailableFrom > mergedDueAt) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "available_from must not be after due_at",
    );
  }

  // Every column is resolved to a plain value here rather than left to a COALESCE or a conditional
  // SQL fragment in the statement below. The nullable fields force it: `description: null` means
  // "clear this" and `description: undefined` means "leave it alone", and COALESCE cannot tell
  // those apart -- it would silently turn every clear into a no-op. Merging in TypeScript, where
  // the stored row is already in hand, makes the distinction explicit and keeps the statement a
  // flat list of bound parameters.
  const merged = {
    title: params.title ?? existing.title,
    description: params.description === undefined ? existing.description : params.description,
    instructions: params.instructions === undefined ? existing.instructions : params.instructions,
    maxScore: params.max_score ?? Number(existing.max_score),
    allowLate: params.allow_late_submission ?? existing.allow_late_submission,
    // Publishing stamps the time; an already-published row keeps the one it has. Required by
    // ck_assignments_lifecycle, which ties assigned_at to the status.
    assignedAt: publishing
      ? new Date().toISOString()
      : (existing.assigned_at?.toISOString() ?? null),
  };

  await tx`
    UPDATE app.assignments
    SET title = ${merged.title},
        description = ${merged.description},
        instructions = ${merged.instructions},
        status = ${nextStatus}::app.assignment_status,
        available_from = ${mergedAvailableFrom}::timestamptz,
        due_at = ${mergedDueAt}::timestamptz,
        max_score = ${merged.maxScore},
        allow_late_submission = ${merged.allowLate},
        assigned_at = ${merged.assignedAt}::timestamptz,
        last_edited_by_user_id = ${userId},
        updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId} AND id = ${assignmentId}
  `;

  const updated = await getAssignmentForUpdate(tx, schoolId, assignmentId);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "assignments",
    targetId: assignmentId,
    oldValues: auditableFields(existing),
    newValues: auditableFields(updated!),
  });

  if (publishing && nextStatus === "published") {
    await emit(tx, DOMAIN_EVENTS.ASSIGNMENT_PUBLISHED, {
      assignmentId,
      courseId: updated!.course_id,
    });
  }

  // Only a later deadline counts as an extension. Pulling a due date forward is a different event
  // for a student -- it takes time away rather than granting it -- and ASSIGNMENT_DEADLINE_EXTENDED
  // would misdescribe it to every downstream consumer.
  if (updated!.due_at.getTime() > existing.due_at.getTime() && existing.status !== "draft") {
    await emit(tx, DOMAIN_EVENTS.ASSIGNMENT_DEADLINE_EXTENDED, {
      assignmentId,
      courseId: updated!.course_id,
    });
  }

  return updated!;
}

/** What deleteAssignment actually did, so the caller can report it accurately. */
export type DeleteOutcome = "deleted" | "archived";

/**
 * Delete an assignment, or archive it when students have already engaged with it.
 *
 * app.assignment_submissions references assignments ON DELETE RESTRICT, so a hard delete of an
 * assignment with submissions cannot succeed -- and should not: the submissions are student work,
 * and removing the assignment out from under them would orphan a graded record. Archiving instead
 * matches what subjects and courses already do when a dependent exists.
 *
 * Attachments carry ON DELETE CASCADE (000047), so the hard-delete path takes their rows with it.
 * The stored objects are deliberately left in the bucket: deleting them is not transactional with
 * the database, so a rolled-back transaction would have already destroyed a file it then claimed
 * still existed. Reclaiming orphaned permanent objects is a sweep job, not a request-path concern.
 */
export async function deleteAssignment(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  assignmentId: string,
): Promise<DeleteOutcome> {
  const existing = await getAssignmentForUpdate(tx, schoolId, assignmentId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Assignment not found");
  }

  await assertCanManageClass(tx, existing.class_id);

  const [submission] = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM app.assignment_submissions
      WHERE assignment_id = ${assignmentId} AND school_id = ${schoolId}
    ) AS exists
  `;

  if (submission?.exists) {
    await tx`
      UPDATE app.assignments
      SET status = 'archived',
          last_edited_by_user_id = ${userId},
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId} AND id = ${assignmentId}
    `;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "assignments",
      targetId: assignmentId,
      oldValues: auditableFields(existing),
      newValues: { ...auditableFields(existing), status: "archived" },
    });

    return "archived";
  }

  await tx`
    DELETE FROM app.assignments
    WHERE school_id = ${schoolId} AND id = ${assignmentId}
  `;

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "assignments",
    targetId: assignmentId,
    oldValues: auditableFields(existing),
  });

  return "deleted";
}
