import { ERROR_CODES } from "@studafy/constants";
import { canChangeExamEntryStatus, nextCandidateNumbers } from "@studafy/grading-engine";
import { csvCell } from "@studafy/sanitize";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { assertCanReadStudent } from "../external-exams/service";

import type { ExamEntryStatus } from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Exam entries (000262): sessions of a catalogue external exam ("IGCSE May/June 2027") and the
 * students the school enters for them, with their subjects, tiers, candidate numbers and status.
 *
 * School leadership manages everything here; the routes gate it on academicConfig:manage. A
 * student's own entries are read by whoever may read the student (app.can_read_student, as RLS has
 * it); drafts are the school's planning and are not shown there.
 */

// ---------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------

export interface ExamSessionView {
  id: string;
  exam: { id: string; code: string; name: string; per_subject: boolean; archived: boolean };
  series: string;
  entry_deadline: string | null;
  starts_on: string | null;
  ends_on: string | null;
  results_date: string | null;
  note: string | null;
  draft_count: number;
  entered_count: number;
  withdrawn_count: number;
  created_at: string;
  updated_at: string;
}

export interface ExamSessionInput {
  series: string;
  entry_deadline?: string | null | undefined;
  starts_on?: string | null | undefined;
  ends_on?: string | null | undefined;
  results_date?: string | null | undefined;
  note?: string | null | undefined;
}

export interface ExamEntrySubjectInput {
  subject_id: string;
  tier?: string | null | undefined;
  option_code?: string | null | undefined;
}

export interface ExamEntrySubjectView {
  subject_id: string;
  code: string;
  name: string;
  tier: string | null;
  option_code: string | null;
}

export interface ExamEntryView {
  id: string;
  session_id: string;
  student: {
    id: string;
    admission_number: string;
    first_name: string;
    last_name: string;
    grade_level_name: string | null;
    section_name: string | null;
  };
  candidate_number: string | null;
  status: ExamEntryStatus;
  note: string | null;
  subjects: ExamEntrySubjectView[];
  result_count: number;
  entered_at: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExamSessionSubjectCount {
  subject_id: string;
  code: string;
  name: string;
  draft: number;
  entered: number;
  withdrawn: number;
}

export interface BulkCreateExamEntriesInput {
  student_ids?: string[] | undefined;
  section_id?: string | undefined;
  grade_level_id?: string | undefined;
  academic_year_id?: string | undefined;
  subjects: ExamEntrySubjectInput[];
  status?: ExamEntryStatus | undefined;
}

export interface StudentExamEntryView {
  id: string;
  exam: { id: string; code: string; name: string };
  session: {
    id: string;
    series: string;
    entry_deadline: string | null;
    starts_on: string | null;
    ends_on: string | null;
    results_date: string | null;
  };
  candidate_number: string | null;
  status: ExamEntryStatus;
  subjects: {
    subject: { id: string; code: string; name: string } | null;
    tier: string | null;
    option_code: string | null;
  }[];
  entered_at: string | null;
  withdrawn_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

function conflict(message: string): never {
  throw new CodedHttpException(409, ERROR_CODES.CONFLICT_STATE_MISMATCH, message);
}

function notFound(message: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, message);
}

function duplicate(message: string): never {
  throw new CodedHttpException(409, ERROR_CODES.CONFLICT_DUPLICATE_ENTRY, message);
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === code;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  exam_id: string;
  exam_code: string;
  exam_name: string;
  per_subject: boolean;
  archived: boolean;
  series: string;
  entry_deadline: string | null;
  starts_on: string | null;
  ends_on: string | null;
  results_date: string | null;
  note: string | null;
  draft_count: number;
  entered_count: number;
  withdrawn_count: number;
  created_at: Date;
  updated_at: Date;
}

function toSessionView(row: SessionRow): ExamSessionView {
  return {
    id: row.id,
    exam: {
      id: row.exam_id,
      code: row.exam_code,
      name: row.exam_name,
      per_subject: row.per_subject,
      archived: row.archived,
    },
    series: row.series,
    entry_deadline: row.entry_deadline,
    starts_on: row.starts_on,
    ends_on: row.ends_on,
    results_date: row.results_date,
    note: row.note,
    draft_count: row.draft_count,
    entered_count: row.entered_count,
    withdrawn_count: row.withdrawn_count,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function loadSessions(
  tx: TransactionSql,
  schoolId: string,
  filter: { examId?: string | undefined; sessionId?: string | undefined },
): Promise<SessionRow[]> {
  const examClause = filter.examId ? tx`AND session.exam_id = ${filter.examId}::uuid` : tx``;
  const idClause = filter.sessionId ? tx`AND session.id = ${filter.sessionId}::uuid` : tx``;
  return tx<SessionRow[]>`
    SELECT session.id, exam.id AS exam_id, exam.code AS exam_code, exam.name AS exam_name,
           exam.per_subject, exam.archived_at IS NOT NULL AS archived, session.series,
           session.entry_deadline::text AS entry_deadline, session.starts_on::text AS starts_on,
           session.ends_on::text AS ends_on, session.results_date::text AS results_date,
           session.note, session.created_at, session.updated_at,
           count(entry.id) FILTER (WHERE entry.status = 'draft')::int AS draft_count,
           count(entry.id) FILTER (WHERE entry.status = 'entered')::int AS entered_count,
           count(entry.id) FILTER (WHERE entry.status = 'withdrawn')::int AS withdrawn_count
    FROM app.external_exam_sessions AS session
    JOIN app.external_exams AS exam
      ON exam.id = session.exam_id AND exam.school_id = session.school_id
    LEFT JOIN app.external_exam_entries AS entry
      ON entry.session_id = session.id AND entry.school_id = session.school_id
    WHERE session.school_id = ${schoolId}::uuid ${examClause} ${idClause}
    GROUP BY session.id, exam.id
    ORDER BY session.starts_on DESC NULLS LAST, exam.name, session.series
  `;
}

export async function listExamSessions(
  tx: TransactionSql,
  schoolId: string,
  examId: string | undefined,
): Promise<ExamSessionView[]> {
  return (await loadSessions(tx, schoolId, { examId })).map(toSessionView);
}

async function requireSession(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
  lock = false,
): Promise<SessionRow> {
  if (lock) {
    // Serializes writers of one session (candidate numbering, bulk entry).
    await tx`
      SELECT id FROM app.external_exam_sessions
      WHERE id = ${sessionId}::uuid AND school_id = ${schoolId}::uuid
      FOR UPDATE
    `;
  }
  const [row] = await loadSessions(tx, schoolId, { sessionId });
  if (!row) notFound("Exam session not found");
  return row;
}

function checkSessionDates(input: ExamSessionInput): void {
  if (input.ends_on && !input.starts_on) invalid("Give the first exam date with the last one.");
  if (input.ends_on && input.starts_on && input.ends_on < input.starts_on) {
    invalid("The last exam date is before the first.");
  }
}

function duplicateSeries(series: string): never {
  duplicate(`This exam already has a "${series}" session`);
}

export async function createExamSession(
  tx: TransactionSql,
  schoolId: string,
  input: ExamSessionInput & { exam_id: string },
): Promise<ExamSessionView> {
  checkSessionDates(input);
  const [exam] = await tx<{ id: string; name: string; archived: boolean }[]>`
    SELECT id, name, archived_at IS NOT NULL AS archived FROM app.external_exams
    WHERE id = ${input.exam_id}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!exam) notFound("External exam not found");
  if (exam.archived) conflict(`${exam.name} is archived: restore it to add a session`);
  let sessionId: string;
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.external_exam_sessions (
          school_id, exam_id, series, entry_deadline, starts_on, ends_on, results_date, note
        )
        VALUES (
          ${schoolId}::uuid, ${exam.id}::uuid, ${input.series}, ${input.entry_deadline ?? null}::date,
          ${input.starts_on ?? null}::date, ${input.ends_on ?? null}::date,
          ${input.results_date ?? null}::date, ${input.note ?? null}
        )
        RETURNING id
      `,
    );
    sessionId = row!.id;
  } catch (error) {
    if (isPgError(error, "23505")) duplicateSeries(input.series);
    throw error;
  }
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "external_exam_sessions",
    targetId: sessionId,
    newValues: { exam_id: exam.id, ...sessionAuditValues(input) },
  });
  return toSessionView(await requireSession(tx, schoolId, sessionId));
}

function sessionAuditValues(input: ExamSessionInput) {
  return {
    series: input.series,
    entry_deadline: input.entry_deadline ?? null,
    starts_on: input.starts_on ?? null,
    ends_on: input.ends_on ?? null,
    results_date: input.results_date ?? null,
  };
}

export async function updateExamSession(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
  input: ExamSessionInput,
): Promise<ExamSessionView> {
  checkSessionDates(input);
  const before = await requireSession(tx, schoolId, sessionId, true);
  try {
    await tx.savepoint(async (sp) => {
      await sp`
        UPDATE app.external_exam_sessions
        SET series = ${input.series}, entry_deadline = ${input.entry_deadline ?? null}::date,
            starts_on = ${input.starts_on ?? null}::date, ends_on = ${input.ends_on ?? null}::date,
            results_date = ${input.results_date ?? null}::date, note = ${input.note ?? null},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${sessionId}::uuid AND school_id = ${schoolId}::uuid
      `;
    });
  } catch (error) {
    if (isPgError(error, "23505")) duplicateSeries(input.series);
    throw error;
  }
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "external_exam_sessions",
    targetId: sessionId,
    oldValues: sessionAuditValues(before),
    newValues: sessionAuditValues(input),
  });
  return toSessionView(await requireSession(tx, schoolId, sessionId));
}

/** Only a session nobody is entered in (draft entries included) can be deleted. */
export async function deleteExamSession(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
): Promise<void> {
  const before = await requireSession(tx, schoolId, sessionId, true);
  if (before.draft_count + before.entered_count + before.withdrawn_count > 0) {
    conflict("Students are entered in this session: it can no longer be deleted");
  }
  await tx`
    DELETE FROM app.external_exam_sessions
    WHERE id = ${sessionId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "external_exam_sessions",
    targetId: sessionId,
    oldValues: { exam_id: before.exam_id, ...sessionAuditValues(before) },
  });
}

// ---------------------------------------------------------------------------
// Entries: reading
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  session_id: string;
  student_id: string;
  admission_number: string;
  first_name: string;
  last_name: string;
  grade_level_name: string | null;
  section_name: string | null;
  candidate_number: string | null;
  status: ExamEntryStatus;
  note: string | null;
  result_count: number;
  entered_at: Date | null;
  withdrawn_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface EntrySubjectRow extends ExamEntrySubjectView {
  entry_id: string;
}

async function loadEntries(
  tx: TransactionSql,
  schoolId: string,
  filter: { sessionId: string } | { entryId: string },
): Promise<ExamEntryView[]> {
  const where =
    "sessionId" in filter
      ? tx`entry.session_id = ${filter.sessionId}::uuid`
      : tx`entry.id = ${filter.entryId}::uuid`;
  const rows = await tx<EntryRow[]>`
    SELECT entry.id, entry.session_id, student.id AS student_id, student.admission_number,
           student.first_name, student.last_name, placement.grade_level_name,
           placement.section_name, entry.candidate_number, entry.status, entry.note,
           entry.entered_at, entry.withdrawn_at, entry.created_at, entry.updated_at,
           (SELECT count(*)::int FROM app.student_external_exam_results AS result
            WHERE result.school_id = entry.school_id AND result.entry_id = entry.id) AS result_count
    FROM app.external_exam_entries AS entry
    JOIN app.students AS student
      ON student.id = entry.student_id AND student.school_id = entry.school_id
    LEFT JOIN LATERAL (
      SELECT grade.name AS grade_level_name, section.name AS section_name
      FROM app.student_sections AS placed
      JOIN app.sections AS section
        ON section.id = placed.section_id AND section.school_id = placed.school_id
      JOIN app.grade_levels AS grade
        ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
      JOIN app.academic_years AS year
        ON year.id = placed.academic_year_id AND year.school_id = placed.school_id
      WHERE placed.school_id = entry.school_id AND placed.student_id = entry.student_id
      ORDER BY year.starts_on DESC
      LIMIT 1
    ) AS placement ON true
    WHERE entry.school_id = ${schoolId}::uuid AND ${where}
    ORDER BY student.last_name, student.first_name, student.id
  `;
  if (rows.length === 0) return [];
  const subjects = await tx<EntrySubjectRow[]>`
    SELECT entered.entry_id, entered.subject_id, subject.code, subject.name, entered.tier,
           entered.option_code
    FROM app.external_exam_entry_subjects AS entered
    JOIN app.subjects AS subject
      ON subject.id = entered.subject_id AND subject.school_id = entered.school_id
    WHERE entered.school_id = ${schoolId}::uuid
      AND entered.entry_id = ANY (${rows.map((row) => row.id)}::uuid[])
    ORDER BY subject.name, subject.code
  `;
  const byEntry = groupBy(subjects, (subject) => subject.entry_id);
  return rows.map((row) => ({
    id: row.id,
    session_id: row.session_id,
    student: {
      id: row.student_id,
      admission_number: row.admission_number,
      first_name: row.first_name,
      last_name: row.last_name,
      grade_level_name: row.grade_level_name,
      section_name: row.section_name,
    },
    candidate_number: row.candidate_number,
    status: row.status,
    note: row.note,
    subjects: (byEntry.get(row.id) ?? []).map(({ entry_id: _entryId, ...subject }) => subject),
    result_count: row.result_count,
    entered_at: iso(row.entered_at),
    withdrawn_at: iso(row.withdrawn_at),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

/** A session with its entries (by student name) and how many students take each subject. */
export async function listSessionEntries(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
): Promise<{
  session: ExamSessionView;
  entries: ExamEntryView[];
  subject_counts: ExamSessionSubjectCount[];
}> {
  const session = toSessionView(await requireSession(tx, schoolId, sessionId));
  const entries = await loadEntries(tx, schoolId, { sessionId });
  const counts = new Map<string, ExamSessionSubjectCount>();
  for (const entry of entries) {
    for (const subject of entry.subjects) {
      const count = counts.get(subject.subject_id) ?? {
        subject_id: subject.subject_id,
        code: subject.code,
        name: subject.name,
        draft: 0,
        entered: 0,
        withdrawn: 0,
      };
      if (entry.status === "draft") count.draft += 1;
      else if (entry.status === "entered") count.entered += 1;
      else count.withdrawn += 1;
      counts.set(subject.subject_id, count);
    }
  }
  const subject_counts = [...counts.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code),
  );
  return { session, entries, subject_counts };
}

async function getEntry(tx: TransactionSql, schoolId: string, entryId: string) {
  const [entry] = await loadEntries(tx, schoolId, { entryId });
  if (!entry) notFound("Exam entry not found");
  return entry;
}

// ---------------------------------------------------------------------------
// Entries: writing
// ---------------------------------------------------------------------------

interface CheckedSubject {
  subject_id: string;
  tier: string | null;
  option_code: string | null;
}

/** A per-subject exam needs at least one subject, any other none; each subject once, in the school. */
async function checkSubjects(
  tx: TransactionSql,
  schoolId: string,
  session: SessionRow,
  subjects: readonly ExamEntrySubjectInput[],
): Promise<CheckedSubject[]> {
  if (session.per_subject && subjects.length === 0) {
    invalid(`${session.exam_name} is entered per subject: choose at least one subject.`);
  }
  if (!session.per_subject && subjects.length > 0) {
    invalid(`${session.exam_name} is not entered per subject.`);
  }
  const ids = subjects.map((subject) => subject.subject_id);
  if (new Set(ids).size !== ids.length) invalid("A subject is listed twice.");
  if (ids.length > 0) {
    const [found] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.subjects
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${ids}::uuid[])
    `;
    if ((found?.count ?? 0) !== ids.length) notFound("Subject not found");
  }
  return subjects.map((subject) => ({
    subject_id: subject.subject_id,
    tier: subject.tier ?? null,
    option_code: subject.option_code ?? null,
  }));
}

/** The students a bulk request names: a list, a section's and a grade's enrolled students. */
async function targetStudents(
  tx: TransactionSql,
  schoolId: string,
  input: BulkCreateExamEntriesInput,
): Promise<string[]> {
  const listed = [...new Set(input.student_ids ?? [])];
  if (listed.length === 0 && !input.section_id && !input.grade_level_id) {
    invalid("Choose students, a section or a grade to enter.");
  }
  if (input.grade_level_id && !input.academic_year_id) {
    invalid("Choose the academic year of the grade's sections.");
  }
  const targets = new Set<string>();
  if (listed.length > 0) {
    const found = await tx<{ id: string }[]>`
      SELECT id FROM app.students
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${listed}::uuid[])
    `;
    if (found.length !== listed.length) notFound("Student not found");
    for (const student of found) targets.add(student.id);
  }
  if (input.section_id) {
    const [section] = await tx<{ id: string }[]>`
      SELECT id FROM app.sections
      WHERE id = ${input.section_id}::uuid AND school_id = ${schoolId}::uuid
    `;
    if (!section) notFound("Section not found");
    const placed = await tx<{ student_id: string }[]>`
      SELECT placed.student_id
      FROM app.student_sections AS placed
      JOIN app.students AS student
        ON student.id = placed.student_id AND student.school_id = placed.school_id
      WHERE placed.school_id = ${schoolId}::uuid AND placed.section_id = ${input.section_id}::uuid
        AND student.status = 'enrolled'
    `;
    for (const row of placed) targets.add(row.student_id);
  }
  if (input.grade_level_id && input.academic_year_id) {
    const [grade] = await tx<{ id: string }[]>`
      SELECT grade.id FROM app.grade_levels AS grade
      JOIN app.academic_years AS year
        ON year.school_id = grade.school_id AND year.id = ${input.academic_year_id}::uuid
      WHERE grade.id = ${input.grade_level_id}::uuid AND grade.school_id = ${schoolId}::uuid
    `;
    if (!grade) notFound("Grade level or academic year not found");
    const placed = await tx<{ student_id: string }[]>`
      SELECT placed.student_id
      FROM app.student_sections AS placed
      JOIN app.sections AS section
        ON section.id = placed.section_id AND section.school_id = placed.school_id
      JOIN app.students AS student
        ON student.id = placed.student_id AND student.school_id = placed.school_id
      WHERE placed.school_id = ${schoolId}::uuid
        AND placed.academic_year_id = ${input.academic_year_id}::uuid
        AND section.grade_level_id = ${input.grade_level_id}::uuid
        AND student.status = 'enrolled'
    `;
    for (const row of placed) targets.add(row.student_id);
  }
  return [...targets];
}

/**
 * Enter students in bulk. New students get an entry with the subjects; students already entered
 * (draft or entered) get the subjects they lack, keeping the tier and code of those they have;
 * withdrawn entries are left alone.
 */
export async function bulkCreateExamEntries(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sessionId: string,
  input: BulkCreateExamEntriesInput,
): Promise<{ created: number; updated: number; unchanged: number; skipped_withdrawn: number }> {
  const session = await requireSession(tx, schoolId, sessionId, true);
  if (session.archived) conflict(`${session.exam_name} is archived: restore it to enter students`);
  const status = input.status ?? "draft";
  if (status === "withdrawn") invalid("New entries are draft or entered.");
  const subjects = await checkSubjects(tx, schoolId, session, input.subjects);
  const students = await targetStudents(tx, schoolId, input);
  if (students.length === 0) return { created: 0, updated: 0, unchanged: 0, skipped_withdrawn: 0 };

  const created = await tx<{ id: string; student_id: string }[]>`
    INSERT INTO app.external_exam_entries (
      school_id, session_id, exam_id, student_id, status, entered_at, created_by_user_id
    )
    SELECT ${schoolId}::uuid, ${sessionId}::uuid, ${session.exam_id}::uuid, student_id, ${status},
           ${status === "entered" ? tx`CURRENT_TIMESTAMP` : null}, ${userId}::uuid
    FROM unnest(${students}::uuid[]) AS student_id
    ON CONFLICT (school_id, session_id, student_id) DO NOTHING
    RETURNING id, student_id
  `;
  const createdIds = new Set(created.map((row) => row.id));
  const [withdrawn] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.external_exam_entries
    WHERE school_id = ${schoolId}::uuid AND session_id = ${sessionId}::uuid
      AND student_id = ANY (${students}::uuid[]) AND status = 'withdrawn'
  `;
  const added =
    subjects.length === 0
      ? []
      : await tx<{ entry_id: string; subject_id: string }[]>`
          INSERT INTO app.external_exam_entry_subjects (
            school_id, entry_id, student_id, subject_id, tier, option_code
          )
          SELECT entry.school_id, entry.id, entry.student_id, chosen.subject_id, chosen.tier,
                 chosen.option_code
          FROM app.external_exam_entries AS entry
          CROSS JOIN unnest(
            ${subjects.map((s) => s.subject_id)}::uuid[],
            ${subjects.map((s) => s.tier)}::text[],
            ${subjects.map((s) => s.option_code)}::text[]
          ) AS chosen (subject_id, tier, option_code)
          WHERE entry.school_id = ${schoolId}::uuid AND entry.session_id = ${sessionId}::uuid
            AND entry.student_id = ANY (${students}::uuid[]) AND entry.status <> 'withdrawn'
          ON CONFLICT (school_id, entry_id, subject_id) DO NOTHING
          RETURNING entry_id, subject_id
        `;
  const addedByEntry = groupBy(added, (row) => row.entry_id);

  for (const row of created) {
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "external_exam_entries",
      targetId: row.id,
      newValues: {
        session_id: sessionId,
        student_id: row.student_id,
        status,
        subjects: subjects.map((subject) => subject.subject_id),
      },
    });
  }
  let updated = 0;
  for (const [entryId, rows] of addedByEntry) {
    if (createdIds.has(entryId)) continue;
    updated += 1;
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "external_exam_entries",
      targetId: entryId,
      newValues: { subjects_added: rows.map((row) => row.subject_id) },
    });
  }
  const skipped = withdrawn?.count ?? 0;
  return {
    created: created.length,
    updated,
    unchanged: students.length - created.length - updated - skipped,
    skipped_withdrawn: skipped,
  };
}

async function requireEntryRow(tx: TransactionSql, schoolId: string, entryId: string) {
  const [row] = await tx<
    {
      id: string;
      session_id: string;
      student_id: string;
      status: ExamEntryStatus;
      candidate_number: string | null;
      note: string | null;
    }[]
  >`
    SELECT id, session_id, student_id, status, candidate_number, note
    FROM app.external_exam_entries
    WHERE id = ${entryId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!row) notFound("Exam entry not found");
  return row;
}

function duplicateCandidateNumber(candidateNumber: string): never {
  duplicate(`Candidate number ${candidateNumber} is already used in this session`);
}

/** Replace an entry's candidate number, note and subjects (tiers and codes included). */
export async function updateExamEntry(
  tx: TransactionSql,
  schoolId: string,
  entryId: string,
  input: {
    candidate_number: string | null;
    note?: string | null | undefined;
    subjects: ExamEntrySubjectInput[];
  },
): Promise<ExamEntryView> {
  const before = await requireEntryRow(tx, schoolId, entryId);
  const session = await requireSession(tx, schoolId, before.session_id);
  const subjects = await checkSubjects(tx, schoolId, session, input.subjects);
  const [oldSubjects] = await tx<{ ids: string[] | null }[]>`
    SELECT array_agg(subject_id ORDER BY subject_id) AS ids FROM app.external_exam_entry_subjects
    WHERE school_id = ${schoolId}::uuid AND entry_id = ${entryId}::uuid
  `;
  try {
    await tx.savepoint(async (sp) => {
      await sp`
        UPDATE app.external_exam_entries
        SET candidate_number = ${input.candidate_number}, note = ${input.note ?? null},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${entryId}::uuid AND school_id = ${schoolId}::uuid
      `;
    });
  } catch (error) {
    if (isPgError(error, "23505")) duplicateCandidateNumber(input.candidate_number ?? "");
    throw error;
  }
  await tx`
    DELETE FROM app.external_exam_entry_subjects
    WHERE school_id = ${schoolId}::uuid AND entry_id = ${entryId}::uuid
      AND NOT (subject_id = ANY (${subjects.map((s) => s.subject_id)}::uuid[]))
  `;
  for (const subject of subjects) {
    await tx`
      INSERT INTO app.external_exam_entry_subjects (
        school_id, entry_id, student_id, subject_id, tier, option_code
      )
      VALUES (
        ${schoolId}::uuid, ${entryId}::uuid, ${before.student_id}::uuid,
        ${subject.subject_id}::uuid, ${subject.tier}, ${subject.option_code}
      )
      ON CONFLICT (school_id, entry_id, subject_id)
      DO UPDATE SET tier = EXCLUDED.tier, option_code = EXCLUDED.option_code
    `;
  }
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "external_exam_entries",
    targetId: entryId,
    oldValues: {
      candidate_number: before.candidate_number,
      note: before.note,
      subjects: oldSubjects?.ids ?? [],
    },
    newValues: {
      candidate_number: input.candidate_number,
      note: input.note ?? null,
      subjects: subjects.map((subject) => subject.subject_id).sort(),
    },
  });
  return getEntry(tx, schoolId, entryId);
}

/** Only a draft is deleted; an entry sent to the board is withdrawn instead. */
export async function deleteExamEntry(
  tx: TransactionSql,
  schoolId: string,
  entryId: string,
): Promise<void> {
  const before = await requireEntryRow(tx, schoolId, entryId);
  if (before.status !== "draft") {
    conflict("Only a draft entry can be deleted: withdraw an entry sent to the board");
  }
  await tx`
    DELETE FROM app.external_exam_entries
    WHERE id = ${entryId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "external_exam_entries",
    targetId: entryId,
    oldValues: {
      session_id: before.session_id,
      student_id: before.student_id,
      candidate_number: before.candidate_number,
    },
  });
}

/**
 * Move entries of one session to `status`, all or none: draft → entered, entered → withdrawn,
 * withdrawn → entered. Entries already in `status` are left as they are.
 */
export async function changeExamEntryStatus(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
  input: { entry_ids: string[]; status: ExamEntryStatus },
): Promise<{ updated: number }> {
  await requireSession(tx, schoolId, sessionId, true);
  const ids = [...new Set(input.entry_ids)];
  const rows = await tx<{ id: string; status: ExamEntryStatus }[]>`
    SELECT id, status FROM app.external_exam_entries
    WHERE school_id = ${schoolId}::uuid AND session_id = ${sessionId}::uuid
      AND id = ANY (${ids}::uuid[])
    FOR UPDATE
  `;
  if (rows.length !== ids.length) notFound("Exam entry not found in this session");
  const changing = rows.filter((row) => row.status !== input.status);
  const refused = changing.filter((row) => !canChangeExamEntryStatus(row.status, input.status));
  if (refused.length > 0) {
    conflict(
      input.status === "withdrawn"
        ? `${refused.length} draft entr${refused.length === 1 ? "y was" : "ies were"} never sent to the board: delete ${refused.length === 1 ? "it" : "them"} instead`
        : `${refused.length} entr${refused.length === 1 ? "y" : "ies"} cannot be moved to ${input.status}`,
    );
  }
  for (const row of changing) {
    await tx`
      UPDATE app.external_exam_entries
      SET status = ${input.status},
          entered_at = CASE WHEN ${input.status} = 'entered'
                            THEN coalesce(entered_at, CURRENT_TIMESTAMP) ELSE entered_at END,
          withdrawn_at = CASE WHEN ${input.status} = 'withdrawn' THEN CURRENT_TIMESTAMP END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${row.id}::uuid AND school_id = ${schoolId}::uuid
    `;
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "external_exam_entries",
      targetId: row.id,
      oldValues: { status: row.status },
      newValues: { status: input.status },
    });
  }
  return { updated: changing.length };
}

/**
 * Number the session's draft and entered entries that have no candidate number, by student name,
 * from `start`, skipping numbers already used in the session.
 */
export async function assignCandidateNumbers(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
  input: { start: number; width?: number | undefined; prefix?: string | undefined },
): Promise<{ assigned: number }> {
  await requireSession(tx, schoolId, sessionId, true);
  const used = await tx<{ candidate_number: string }[]>`
    SELECT candidate_number FROM app.external_exam_entries
    WHERE school_id = ${schoolId}::uuid AND session_id = ${sessionId}::uuid
      AND candidate_number IS NOT NULL
  `;
  const unnumbered = await tx<{ id: string }[]>`
    SELECT entry.id
    FROM app.external_exam_entries AS entry
    JOIN app.students AS student
      ON student.id = entry.student_id AND student.school_id = entry.school_id
    WHERE entry.school_id = ${schoolId}::uuid AND entry.session_id = ${sessionId}::uuid
      AND entry.candidate_number IS NULL AND entry.status <> 'withdrawn'
    ORDER BY student.last_name, student.first_name, student.id
  `;
  const numbers = nextCandidateNumbers(
    unnumbered.length,
    { start: input.start, width: input.width ?? 0, prefix: input.prefix ?? "" },
    used.map((row) => row.candidate_number),
  );
  if (numbers.some((number) => number.length > 20)) {
    invalid("Candidate numbers are at most 20 characters: use a shorter prefix or width.");
  }
  for (const [index, entry] of unnumbered.entries()) {
    const candidateNumber = numbers[index]!;
    await tx`
      UPDATE app.external_exam_entries
      SET candidate_number = ${candidateNumber}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${entry.id}::uuid AND school_id = ${schoolId}::uuid
    `;
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "external_exam_entries",
      targetId: entry.id,
      oldValues: { candidate_number: null },
      newValues: { candidate_number: candidateNumber },
    });
  }
  return { assigned: unnumbered.length };
}

// ---------------------------------------------------------------------------
// The entry list for the exam board (CSV)
// ---------------------------------------------------------------------------

const UTF8_BOM = String.fromCharCode(0xfeff);

const CSV_HEADER = [
  "Candidate number",
  "Admission number",
  "Last name",
  "First name",
  "Middle name",
  "Date of birth",
  "Exam",
  "Series",
  "Subject code",
  "Subject",
  "Tier",
  "Option code",
  "Status",
];

/**
 * The session's entries as CSV (UTF-8 with a byte-order mark, so Excel reads Arabic names), one row
 * per entered subject -- one per entry for an exam not entered per subject -- by candidate number
 * then name. Drafts are left out unless asked for. Audited as an export.
 */
export async function exportSessionEntriesCsv(
  tx: TransactionSql,
  schoolId: string,
  sessionId: string,
  includeDrafts: boolean,
): Promise<{ fileName: string; csv: string }> {
  const session = await requireSession(tx, schoolId, sessionId);
  const draftClause = includeDrafts ? tx`` : tx`AND entry.status <> 'draft'`;
  const rows = await tx<
    {
      entry_id: string;
      candidate_number: string | null;
      admission_number: string;
      last_name: string;
      first_name: string;
      middle_name: string | null;
      date_of_birth: string | null;
      subject_code: string | null;
      subject_name: string | null;
      tier: string | null;
      option_code: string | null;
      status: ExamEntryStatus;
    }[]
  >`
    SELECT entry.id AS entry_id, entry.candidate_number, student.admission_number,
           student.last_name, student.first_name, student.middle_name,
           student.date_of_birth::text AS date_of_birth, subject.code AS subject_code,
           subject.name AS subject_name, entered.tier, entered.option_code, entry.status
    FROM app.external_exam_entries AS entry
    JOIN app.students AS student
      ON student.id = entry.student_id AND student.school_id = entry.school_id
    LEFT JOIN app.external_exam_entry_subjects AS entered
      ON entered.entry_id = entry.id AND entered.school_id = entry.school_id
    LEFT JOIN app.subjects AS subject
      ON subject.id = entered.subject_id AND subject.school_id = entered.school_id
    WHERE entry.school_id = ${schoolId}::uuid AND entry.session_id = ${sessionId}::uuid
      ${draftClause}
    ORDER BY entry.candidate_number NULLS LAST, student.last_name, student.first_name,
             student.id, subject.code
  `;
  const lines = [CSV_HEADER.map((value) => csvCell(value)).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.candidate_number,
        row.admission_number,
        row.last_name,
        row.first_name,
        row.middle_name,
        row.date_of_birth,
        session.exam_code,
        session.series,
        row.subject_code,
        row.subject_name,
        row.tier,
        row.option_code,
        row.status,
      ]
        .map((value) => csvCell(value))
        .join(","),
    );
  }
  await emitAuditLog(tx, {
    action: "export",
    targetTable: "external_exam_entries",
    targetId: sessionId,
    newValues: {
      session_id: sessionId,
      include_drafts: includeDrafts,
      entries: new Set(rows.map((row) => row.entry_id)).size,
    },
  });
  const slug = `${session.exam_code}-${session.series}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return {
    fileName: `${slug || "exam"}-entries.csv`,
    csv: `${UTF8_BOM}${lines.join("\r\n")}\r\n`,
  };
}

// ---------------------------------------------------------------------------
// A student's entries
// ---------------------------------------------------------------------------

/**
 * A student's entries that were sent to the board (entered or withdrawn), latest session first,
 * for leadership, the student's teachers, the student and linked parents. Notes stay with the
 * school.
 */
export async function listStudentExamEntries(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentExamEntryView[]> {
  await assertCanReadStudent(tx, studentId);
  // Leadership of another school passes the role check; the student is not in their school.
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student) notFound("Student not found");
  const rows = await tx<
    {
      id: string;
      exam_id: string;
      exam_code: string;
      exam_name: string;
      session_id: string;
      series: string;
      entry_deadline: string | null;
      starts_on: string | null;
      ends_on: string | null;
      results_date: string | null;
      candidate_number: string | null;
      status: ExamEntryStatus;
      entered_at: Date | null;
      withdrawn_at: Date | null;
    }[]
  >`
    SELECT entry.id, exam.id AS exam_id, exam.code AS exam_code, exam.name AS exam_name,
           session.id AS session_id, session.series,
           session.entry_deadline::text AS entry_deadline, session.starts_on::text AS starts_on,
           session.ends_on::text AS ends_on, session.results_date::text AS results_date,
           entry.candidate_number, entry.status, entry.entered_at, entry.withdrawn_at
    FROM app.external_exam_entries AS entry
    JOIN app.external_exam_sessions AS session
      ON session.id = entry.session_id AND session.school_id = entry.school_id
    JOIN app.external_exams AS exam
      ON exam.id = session.exam_id AND exam.school_id = session.school_id
    WHERE entry.school_id = ${schoolId}::uuid AND entry.student_id = ${studentId}::uuid
      AND entry.status <> 'draft'
    ORDER BY session.starts_on DESC NULLS LAST, exam.name, session.series
  `;
  if (rows.length === 0) return [];
  const entered = await tx<
    { entry_id: string; subject_id: string; tier: string | null; option_code: string | null }[]
  >`
    SELECT entry_id, subject_id, tier, option_code FROM app.external_exam_entry_subjects
    WHERE school_id = ${schoolId}::uuid AND entry_id = ANY (${rows.map((row) => row.id)}::uuid[])
  `;
  // Subject names through app.external_exam_entry_subjects_of: app.subjects' role scope would hide
  // a subject the student takes no class in from the student and their parents (000262).
  const named = await tx<{ subject_id: string; code: string; name: string }[]>`
    SELECT subject_id, code, name FROM app.external_exam_entry_subjects_of(${studentId}::uuid)
  `;
  const subjects = new Map(
    named.map((row) => [row.subject_id, { id: row.subject_id, code: row.code, name: row.name }]),
  );
  const byEntry = groupBy(entered, (row) => row.entry_id);
  return rows.map((row) => ({
    id: row.id,
    exam: { id: row.exam_id, code: row.exam_code, name: row.exam_name },
    session: {
      id: row.session_id,
      series: row.series,
      entry_deadline: row.entry_deadline,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
      results_date: row.results_date,
    },
    candidate_number: row.candidate_number,
    status: row.status,
    subjects: (byEntry.get(row.id) ?? [])
      .map((subject) => ({
        subject: subjects.get(subject.subject_id) ?? null,
        tier: subject.tier,
        option_code: subject.option_code,
      }))
      .sort((a, b) => (a.subject?.name ?? "").localeCompare(b.subject?.name ?? "")),
    entered_at: iso(row.entered_at),
    withdrawn_at: iso(row.withdrawn_at),
  }));
}
