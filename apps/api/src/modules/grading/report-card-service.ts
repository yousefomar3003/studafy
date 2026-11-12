import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { assertCanGradeSectionSubject, requireYear } from "./access";
import { requireSectionRow, resolveSectionSubjects } from "./engine-config";

import type { TransactionSql } from "postgres";

/**
 * Report card notes (000208): per-subject comments from subject teachers, the class teacher's
 * overall comment and conduct rating, an optional principal comment, and the attendance summary.
 *
 * Draft notes are written while a section's term (or year) is open and are locked once that period
 * is finalized. Finalizing (and every correction, which writes a new finalization version) copies
 * them into the append-only snapshot with {@link snapshotReportNotes}; results and certificates are
 * read from the snapshot only, so a later edit can never change a finalized report card.
 *
 * "Class teacher" is any teacher of the section (an explicit subject assignment or a class of the
 * section): Studafy has no separate homeroom assignment, and school leadership can always edit.
 */

export const REPORT_COMMENT_MAX = 1000;

export interface ReportSections {
  show_subject_comments: boolean;
  show_teacher_comment: boolean;
  show_principal_comment: boolean;
  show_attendance: boolean;
  show_conduct: boolean;
}

export interface ConductRating {
  code: string;
  label: string;
  label_ar: string | null;
}

export interface ReportCardSettings extends ReportSections {
  conduct_ratings: ConductRating[];
  /** True while the school has saved no list of its own and gets the default four. */
  conduct_ratings_default: boolean;
}

export const DEFAULT_REPORT_SECTIONS: ReportSections = {
  show_subject_comments: true,
  show_teacher_comment: true,
  show_principal_comment: true,
  show_attendance: true,
  show_conduct: true,
};

export const DEFAULT_CONDUCT_RATINGS: readonly ConductRating[] = [
  { code: "excellent", label: "Excellent", label_ar: "ممتاز" },
  { code: "very_good", label: "Very good", label_ar: "جيد جدًا" },
  { code: "good", label: "Good", label_ar: "جيد" },
  { code: "needs_improvement", label: "Needs improvement", label_ar: "يحتاج إلى تحسين" },
];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** One round trip: the school's settings row (if any) and its conduct list (if any). */
export async function getReportCardSettings(
  tx: TransactionSql,
  schoolId: string,
): Promise<ReportCardSettings> {
  const [row] = await tx<
    ({ [K in keyof ReportSections]: boolean | null } & { ratings: ConductRating[] })[]
  >`
    SELECT settings.show_subject_comments, settings.show_teacher_comment,
           settings.show_principal_comment, settings.show_attendance, settings.show_conduct,
           (
             SELECT coalesce(
               json_agg(
                 json_build_object('code', rating.code, 'label', rating.label,
                                   'label_ar', rating.label_ar)
                 ORDER BY rating.sort_order, rating.code
               ),
               '[]'::json
             )
             FROM app.report_conduct_ratings AS rating
             WHERE rating.school_id = ${schoolId}::uuid
           ) AS ratings
    FROM (SELECT 1) AS one
    LEFT JOIN app.report_card_settings AS settings ON settings.school_id = ${schoolId}::uuid
  `;
  const ratings = row?.ratings ?? [];
  return {
    show_subject_comments:
      row?.show_subject_comments ?? DEFAULT_REPORT_SECTIONS.show_subject_comments,
    show_teacher_comment: row?.show_teacher_comment ?? DEFAULT_REPORT_SECTIONS.show_teacher_comment,
    show_principal_comment:
      row?.show_principal_comment ?? DEFAULT_REPORT_SECTIONS.show_principal_comment,
    show_attendance: row?.show_attendance ?? DEFAULT_REPORT_SECTIONS.show_attendance,
    show_conduct: row?.show_conduct ?? DEFAULT_REPORT_SECTIONS.show_conduct,
    conduct_ratings:
      ratings.length > 0 ? ratings : DEFAULT_CONDUCT_RATINGS.map((rating) => ({ ...rating })),
    conduct_ratings_default: ratings.length === 0,
  };
}

export interface UpdateReportCardSettingsInput extends Partial<ReportSections> {
  conduct_ratings?: ConductRating[];
}

export async function updateReportCardSettings(
  tx: TransactionSql,
  schoolId: string,
  input: UpdateReportCardSettingsInput,
): Promise<ReportCardSettings> {
  const before = await getReportCardSettings(tx, schoolId);
  const next: ReportSections = {
    show_subject_comments: input.show_subject_comments ?? before.show_subject_comments,
    show_teacher_comment: input.show_teacher_comment ?? before.show_teacher_comment,
    show_principal_comment: input.show_principal_comment ?? before.show_principal_comment,
    show_attendance: input.show_attendance ?? before.show_attendance,
    show_conduct: input.show_conduct ?? before.show_conduct,
  };
  await tx`
    INSERT INTO app.report_card_settings (
      school_id, show_subject_comments, show_teacher_comment, show_principal_comment,
      show_attendance, show_conduct
    )
    VALUES (
      ${schoolId}::uuid, ${next.show_subject_comments}, ${next.show_teacher_comment},
      ${next.show_principal_comment}, ${next.show_attendance}, ${next.show_conduct}
    )
    ON CONFLICT (school_id) DO UPDATE SET
      show_subject_comments = EXCLUDED.show_subject_comments,
      show_teacher_comment = EXCLUDED.show_teacher_comment,
      show_principal_comment = EXCLUDED.show_principal_comment,
      show_attendance = EXCLUDED.show_attendance,
      show_conduct = EXCLUDED.show_conduct,
      updated_at = CURRENT_TIMESTAMP
  `;
  if (input.conduct_ratings !== undefined) {
    const codes = new Set<string>();
    for (const rating of input.conduct_ratings) {
      if (codes.has(rating.code)) {
        throw new CodedHttpException(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          `Conduct rating "${rating.code}" is listed twice`,
        );
      }
      codes.add(rating.code);
    }
    // The list is replaced whole. Draft notes keep the code they hold; a code no longer listed is
    // left out when the period is finalized (see snapshotReportNotes).
    await tx`DELETE FROM app.report_conduct_ratings WHERE school_id = ${schoolId}::uuid`;
    if (input.conduct_ratings.length > 0) {
      const rows = input.conduct_ratings.map((rating, index) => ({
        code: rating.code,
        label: rating.label,
        label_ar: rating.label_ar,
        sort_order: index,
      }));
      await tx`
        INSERT INTO app.report_conduct_ratings (school_id, code, label, label_ar, sort_order)
        SELECT ${schoolId}::uuid, x.code, x.label, x.label_ar, x.sort_order
        FROM jsonb_to_recordset(${tx.json(rows as never)}::jsonb) AS x(
          code text, label text, label_ar text, sort_order smallint
        )
      `;
    }
  }
  const after = await getReportCardSettings(tx, schoolId);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "report_card_settings",
    targetId: schoolId,
    oldValues: { ...before },
    newValues: { ...after },
  });
  return after;
}

// ---------------------------------------------------------------------------
// Draft notes
// ---------------------------------------------------------------------------

interface PeriodContext {
  sectionId: string;
  academicYearId: string;
  termId: string | null;
  leadership: boolean;
}

async function requirePeriod(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  termId: string | null,
): Promise<{ academicYearId: string; finalized: boolean; yearStatus: string }> {
  const section = await requireSectionRow(tx, schoolId, sectionId);
  if (termId !== null) {
    const [term] = await tx<{ id: string }[]>`
      SELECT id FROM app.terms
      WHERE id = ${termId}::uuid AND school_id = ${schoolId}::uuid
        AND academic_year_id = ${section.academic_year_id}::uuid
    `;
    if (!term) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Term not found");
    }
  }
  const year = await requireYear(tx, schoolId, section.academic_year_id);
  const [current] = await tx<{ id: string }[]>`
    SELECT id FROM app.result_finalizations
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND status = 'finalized'
  `;
  return {
    academicYearId: section.academic_year_id,
    finalized: current !== undefined,
    yearStatus: year.grading_config_status,
  };
}

/** Notes change only while the period is open: an active year, not yet finalized. */
function assertNotesOpen(period: { finalized: boolean; yearStatus: string }): void {
  if (period.finalized) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULTS_ALREADY_FINALIZED,
      "These results are already finalized, so their report card notes can no longer change",
    );
  }
  if (period.yearStatus !== "active") {
    throw new CodedHttpException(
      409,
      period.yearStatus === "draft"
        ? ERROR_CODES.ACADEMIC_YEAR_NOT_ACTIVE
        : ERROR_CODES.ACADEMIC_CONFIG_LOCKED,
      period.yearStatus === "draft"
        ? "Publish the year's grading configuration before writing report card notes"
        : "This year's results are closed; report card notes are read-only",
    );
  }
}

async function assertTeachesSection(tx: TransactionSql, sectionId: string): Promise<boolean> {
  const [row] = await tx<{ leadership: boolean; teaches: boolean }[]>`
    SELECT app.current_user_is_school_admin() AS leadership,
           app.teaches_in_section(${sectionId}::uuid) AS teaches
  `;
  if (!row?.leadership && !row?.teaches) {
    throw new CodedHttpException(403, ERROR_CODES.AUTHZ_FORBIDDEN, "You do not teach this section");
  }
  return row.leadership;
}

async function sectionStudentIds(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
): Promise<Set<string>> {
  const rows = await tx<{ student_id: string }[]>`
    SELECT student_id FROM app.student_sections
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
  `;
  return new Set(rows.map((row) => row.student_id));
}

function assertStudentsInSection(ids: readonly string[], roster: ReadonlySet<string>): void {
  const outside = ids.filter((id) => !roster.has(id));
  if (outside.length > 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Not in this section: ${outside.slice(0, 5).join(", ")}`,
    );
  }
}

/** Trimmed text, or null for blank: an empty comment clears it. */
function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export interface SectionReportNotesView {
  section_id: string;
  term_id: string | null;
  finalized: boolean;
  editable: boolean;
  can_edit_class_notes: boolean;
  can_edit_principal_comment: boolean;
  settings: ReportCardSettings;
  subjects: { subject_id: string; subject_name: string; can_comment: boolean }[];
  students: {
    student_id: string;
    first_name: string;
    last_name: string;
    admission_number: string;
    teacher_comment: string | null;
    principal_comment: string | null;
    conduct_code: string | null;
    subject_comments: { subject_id: string; body: string }[];
  }[];
}

export async function getSectionReportNotes(
  tx: TransactionSql,
  schoolId: string,
  sectionId: string,
  termId: string | null,
): Promise<SectionReportNotesView> {
  const leadership = await assertTeachesSection(tx, sectionId);
  const period = await requirePeriod(tx, schoolId, sectionId, termId);
  const section = await requireSectionRow(tx, schoolId, sectionId);
  const settings = await getReportCardSettings(tx, schoolId);
  const effective = (await resolveSectionSubjects(tx, schoolId, section)).filter(
    (subject) => subject.source !== "excluded",
  );
  const subjectRows = effective.length
    ? await tx<{ subject_id: string; can_comment: boolean }[]>`
        SELECT subject_id,
               (app.current_user_is_school_admin()
                 OR app.teaches_section_subject(${sectionId}::uuid, subject_id)) AS can_comment
        FROM unnest(${effective.map((s) => s.subject_id) as string[]}::uuid[]) AS subject_id
      `
    : [];
  const canComment = new Map(subjectRows.map((row) => [row.subject_id, row.can_comment]));

  const students = await tx<
    {
      student_id: string;
      first_name: string;
      last_name: string;
      admission_number: string;
      teacher_comment: string | null;
      principal_comment: string | null;
      conduct_code: string | null;
    }[]
  >`
    SELECT student.id AS student_id, student.first_name, student.last_name,
           student.admission_number, note.teacher_comment, note.principal_comment,
           note.conduct_code
    FROM app.student_sections AS placement
    JOIN app.students AS student
      ON student.id = placement.student_id AND student.school_id = placement.school_id
    LEFT JOIN app.report_student_notes AS note
      ON note.school_id = placement.school_id AND note.section_id = placement.section_id
     AND note.student_id = placement.student_id
     AND note.term_id IS NOT DISTINCT FROM ${termId}::uuid
    WHERE placement.school_id = ${schoolId}::uuid AND placement.section_id = ${sectionId}::uuid
    ORDER BY student.last_name, student.first_name, student.id
  `;
  const comments = await tx<{ student_id: string; subject_id: string; body: string }[]>`
    SELECT student_id, subject_id, body
    FROM app.report_subject_comments
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND term_id IS NOT DISTINCT FROM ${termId}::uuid
  `;
  const editable = !period.finalized && period.yearStatus === "active";
  return {
    section_id: sectionId,
    term_id: termId,
    finalized: period.finalized,
    editable,
    can_edit_class_notes: editable,
    can_edit_principal_comment: editable && leadership,
    settings,
    subjects: effective
      .map((subject) => ({
        subject_id: subject.subject_id,
        subject_name: subject.subject_name,
        can_comment: editable && (canComment.get(subject.subject_id) ?? false),
      }))
      .sort((a, b) => a.subject_name.localeCompare(b.subject_name)),
    students: students.map((student) => ({
      ...student,
      subject_comments: comments
        .filter((comment) => comment.student_id === student.student_id)
        .map(({ subject_id, body }) => ({ subject_id, body })),
    })),
  };
}

export async function saveSubjectComments(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  subjectId: string,
  termId: string | null,
  items: readonly { student_id: string; comment: string | null }[],
): Promise<{ saved: number; cleared: number }> {
  await assertCanGradeSectionSubject(tx, sectionId, subjectId);
  const period = await requirePeriod(tx, schoolId, sectionId, termId);
  assertNotesOpen(period);
  const roster = await sectionStudentIds(tx, schoolId, sectionId);
  assertStudentsInSection(
    items.map((item) => item.student_id),
    roster,
  );
  const studentIds = items.map((item) => item.student_id);
  const previous = await tx<{ student_id: string; body: string }[]>`
    SELECT student_id, body FROM app.report_subject_comments
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND subject_id = ${subjectId}::uuid
      AND student_id = ANY (${studentIds}::uuid[])
  `;
  let saved = 0;
  let cleared = 0;
  for (const item of items) {
    const body = clean(item.comment);
    if (body === null) {
      const removed = await tx`
        DELETE FROM app.report_subject_comments
        WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
          AND term_id IS NOT DISTINCT FROM ${termId}::uuid
          AND student_id = ${item.student_id}::uuid AND subject_id = ${subjectId}::uuid
      `;
      cleared += removed.count;
      continue;
    }
    const [updated] = await tx<{ id: string }[]>`
      UPDATE app.report_subject_comments
      SET body = ${body}, author_user_id = ${userId}::uuid, updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
        AND term_id IS NOT DISTINCT FROM ${termId}::uuid
        AND student_id = ${item.student_id}::uuid AND subject_id = ${subjectId}::uuid
      RETURNING id
    `;
    if (!updated) {
      await tx`
        INSERT INTO app.report_subject_comments (
          school_id, academic_year_id, section_id, term_id, student_id, subject_id, body,
          author_user_id
        )
        VALUES (
          ${schoolId}::uuid, ${period.academicYearId}::uuid, ${sectionId}::uuid, ${termId}::uuid,
          ${item.student_id}::uuid, ${subjectId}::uuid, ${body}, ${userId}::uuid
        )
      `;
    }
    saved += 1;
  }
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "report_subject_comments",
    targetId: sectionId,
    oldValues: {
      subject_id: subjectId,
      term_id: termId,
      comments: Object.fromEntries(previous.map((row) => [row.student_id, row.body])),
    },
    newValues: {
      subject_id: subjectId,
      term_id: termId,
      comments: Object.fromEntries(items.map((item) => [item.student_id, clean(item.comment)])),
    },
  });
  return { saved, cleared };
}

export interface StudentNoteInput {
  student_id: string;
  /** Omitted: unchanged. null or blank: cleared. */
  teacher_comment?: string | null;
  principal_comment?: string | null;
  conduct_code?: string | null;
}

export async function saveStudentNotes(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  sectionId: string,
  termId: string | null,
  items: readonly StudentNoteInput[],
): Promise<{ saved: number }> {
  const leadership = await assertTeachesSection(tx, sectionId);
  if (!leadership && items.some((item) => item.principal_comment !== undefined)) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only school leadership can write the principal's comment",
    );
  }
  const period = await requirePeriod(tx, schoolId, sectionId, termId);
  assertNotesOpen(period);
  const roster = await sectionStudentIds(tx, schoolId, sectionId);
  assertStudentsInSection(
    items.map((item) => item.student_id),
    roster,
  );
  const settings = await getReportCardSettings(tx, schoolId);
  const codes = new Set(settings.conduct_ratings.map((rating) => rating.code));
  for (const item of items) {
    if (item.conduct_code && !codes.has(item.conduct_code)) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        `Unknown conduct rating "${item.conduct_code}"`,
      );
    }
  }

  const previous = await tx<
    {
      student_id: string;
      teacher_comment: string | null;
      principal_comment: string | null;
      conduct_code: string | null;
    }[]
  >`
    SELECT student_id, teacher_comment, principal_comment, conduct_code
    FROM app.report_student_notes
    WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
      AND term_id IS NOT DISTINCT FROM ${termId}::uuid
      AND student_id = ANY (${items.map((item) => item.student_id)}::uuid[])
  `;
  for (const item of items) {
    const teacher = item.teacher_comment === undefined ? undefined : clean(item.teacher_comment);
    const principal =
      item.principal_comment === undefined ? undefined : clean(item.principal_comment);
    const conduct = item.conduct_code === undefined ? undefined : item.conduct_code || null;
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM app.report_student_notes
      WHERE school_id = ${schoolId}::uuid AND section_id = ${sectionId}::uuid
        AND term_id IS NOT DISTINCT FROM ${termId}::uuid AND student_id = ${item.student_id}::uuid
      FOR UPDATE
    `;
    if (existing) {
      await tx`
        UPDATE app.report_student_notes SET
          teacher_comment = CASE WHEN ${teacher !== undefined} THEN ${teacher ?? null} ELSE teacher_comment END,
          teacher_comment_by_user_id = CASE WHEN ${teacher !== undefined}
            THEN ${teacher ? userId : null}::uuid ELSE teacher_comment_by_user_id END,
          principal_comment = CASE WHEN ${principal !== undefined} THEN ${principal ?? null} ELSE principal_comment END,
          principal_comment_by_user_id = CASE WHEN ${principal !== undefined}
            THEN ${principal ? userId : null}::uuid ELSE principal_comment_by_user_id END,
          conduct_code = CASE WHEN ${conduct !== undefined} THEN ${conduct ?? null} ELSE conduct_code END,
          conduct_by_user_id = CASE WHEN ${conduct !== undefined}
            THEN ${conduct ? userId : null}::uuid ELSE conduct_by_user_id END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ${existing.id}::uuid AND school_id = ${schoolId}::uuid
      `;
    } else {
      await tx`
        INSERT INTO app.report_student_notes (
          school_id, academic_year_id, section_id, term_id, student_id, teacher_comment,
          teacher_comment_by_user_id, principal_comment, principal_comment_by_user_id, conduct_code,
          conduct_by_user_id
        )
        VALUES (
          ${schoolId}::uuid, ${period.academicYearId}::uuid, ${sectionId}::uuid, ${termId}::uuid,
          ${item.student_id}::uuid, ${teacher ?? null}, ${teacher ? userId : null}::uuid,
          ${principal ?? null}, ${principal ? userId : null}::uuid, ${conduct ?? null},
          ${conduct ? userId : null}::uuid
        )
      `;
    }
  }
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "report_student_notes",
    targetId: sectionId,
    oldValues: {
      term_id: termId,
      students: Object.fromEntries(previous.map(({ student_id, ...note }) => [student_id, note])),
    },
    newValues: {
      term_id: termId,
      students: Object.fromEntries(items.map(({ student_id, ...note }) => [student_id, note])),
    },
  });
  return { saved: items.length };
}

// ---------------------------------------------------------------------------
// Snapshot at finalization, and reading it back
// ---------------------------------------------------------------------------

export interface AttendanceDays {
  from: string;
  to: string;
  days_recorded: number;
  days_present: number;
  days_absent: number;
  days_late: number;
  days_excused: number;
}

/**
 * Copy a section period's draft notes, and the attendance summary, into the append-only snapshot
 * for `finalizationId`: one row per student of the finalization (so "no notes" is recorded as such)
 * plus one per subject comment. Sections the school switched off are not copied. Set-based — a
 * settings read and at most two INSERTs, however large the section.
 *
 * Attendance comes from submitted and locked sessions between the term's (or year's) start and end
 * dates, the attendance reports' rule. It is taken per class session, so sessions are folded into
 * days: a day is present when the student attended any session that day (present, remote or late —
 * the reports count remote as present), late when any of those was late, absent when they attended
 * none and were absent from at least one, and excused when every record that day was excused.
 * present + absent + excused = days recorded; late days are counted within present.
 */
export async function snapshotReportNotes(
  tx: TransactionSql,
  schoolId: string,
  finalization: {
    id: string;
    academic_year_id: string;
    section_id: string;
    term_id: string | null;
  },
): Promise<void> {
  const settings = await getReportCardSettings(tx, schoolId);
  const ratings = settings.show_conduct ? settings.conduct_ratings : [];
  await tx`
    WITH period AS (
      SELECT starts_on AS from_date, ends_on AS to_date
      FROM app.academic_years
      WHERE id = ${finalization.academic_year_id}::uuid AND school_id = ${schoolId}::uuid
        AND ${finalization.term_id}::uuid IS NULL
      UNION ALL
      SELECT starts_on, ends_on
      FROM app.terms
      WHERE id = ${finalization.term_id}::uuid AND school_id = ${schoolId}::uuid
    ),
    students AS (
      SELECT student_id
      FROM app.student_overall_results
      WHERE school_id = ${schoolId}::uuid AND finalization_id = ${finalization.id}::uuid
    ),
    per_day AS (
      SELECT record.student_id, session.session_date,
             bool_or(record.status IN ('present', 'remote', 'late')) AS attended,
             bool_or(record.status = 'late') AS late,
             bool_or(record.status = 'absent') AS absent
      FROM app.attendance_sessions AS session
      JOIN app.attendance_records AS record
        ON record.school_id = session.school_id
       AND record.attendance_session_id = session.id
       AND record.session_created_at = session.created_at
      WHERE ${settings.show_attendance}
        AND session.school_id = ${schoolId}::uuid
        AND session.session_date BETWEEN (SELECT from_date FROM period)
                                     AND (SELECT to_date FROM period)
        AND session.status IN ('submitted', 'locked')
        AND record.student_id IN (SELECT student_id FROM students)
      GROUP BY record.student_id, session.session_date
    ),
    days AS (
      SELECT student_id,
             count(*)::int AS recorded,
             count(*) FILTER (WHERE attended)::int AS present,
             count(*) FILTER (WHERE NOT attended AND absent)::int AS absent,
             count(*) FILTER (WHERE attended AND late)::int AS late,
             count(*) FILTER (WHERE NOT attended AND NOT absent)::int AS excused
      FROM per_day
      GROUP BY student_id
    ),
    ratings AS (
      SELECT code, label, label_ar
      FROM jsonb_to_recordset(${tx.json(ratings as never)}::jsonb)
        AS x(code text, label text, label_ar text)
    )
    INSERT INTO app.finalized_report_notes (
      school_id, finalization_id, student_id, teacher_comment, principal_comment, conduct_code,
      conduct_label, conduct_label_ar, attendance_from, attendance_to, attendance_days_recorded,
      attendance_days_present, attendance_days_absent, attendance_days_late,
      attendance_days_excused
    )
    SELECT ${schoolId}::uuid, ${finalization.id}::uuid, student.student_id,
           CASE WHEN ${settings.show_teacher_comment} THEN note.teacher_comment END,
           CASE WHEN ${settings.show_principal_comment} THEN note.principal_comment END,
           rating.code, rating.label, rating.label_ar,
           CASE WHEN ${settings.show_attendance} THEN period.from_date END,
           CASE WHEN ${settings.show_attendance} THEN period.to_date END,
           CASE WHEN ${settings.show_attendance} THEN coalesce(days.recorded, 0) END,
           CASE WHEN ${settings.show_attendance} THEN coalesce(days.present, 0) END,
           CASE WHEN ${settings.show_attendance} THEN coalesce(days.absent, 0) END,
           CASE WHEN ${settings.show_attendance} THEN coalesce(days.late, 0) END,
           CASE WHEN ${settings.show_attendance} THEN coalesce(days.excused, 0) END
    FROM students AS student
    CROSS JOIN period
    LEFT JOIN app.report_student_notes AS note
      ON note.school_id = ${schoolId}::uuid
     AND note.section_id = ${finalization.section_id}::uuid
     AND note.term_id IS NOT DISTINCT FROM ${finalization.term_id}::uuid
     AND note.student_id = student.student_id
    LEFT JOIN ratings AS rating ON rating.code = note.conduct_code
    LEFT JOIN days ON days.student_id = student.student_id
  `;

  if (settings.show_subject_comments) {
    // Only subjects the student has a finalized result in (the snapshot's foreign key).
    await tx`
      INSERT INTO app.finalized_subject_comments (
        school_id, finalization_id, student_id, subject_id, body
      )
      SELECT ${schoolId}::uuid, ${finalization.id}::uuid, comment.student_id, comment.subject_id,
             comment.body
      FROM app.report_subject_comments AS comment
      JOIN app.student_subject_results AS result
        ON result.school_id = comment.school_id
       AND result.finalization_id = ${finalization.id}::uuid
       AND result.student_id = comment.student_id
       AND result.subject_id = comment.subject_id
      WHERE comment.school_id = ${schoolId}::uuid
        AND comment.section_id = ${finalization.section_id}::uuid
        AND comment.term_id IS NOT DISTINCT FROM ${finalization.term_id}::uuid
    `;
  }
}

export interface ReportNotes {
  teacher_comment: string | null;
  principal_comment: string | null;
  conduct: { code: string; label: string; label_ar: string | null } | null;
  attendance: AttendanceDays | null;
}

/** The snapshot for students of one finalization; finalizations from before 000208 have none. */
export async function readReportNotes(
  tx: TransactionSql,
  schoolId: string,
  finalizationId: string,
  studentId?: string,
): Promise<{
  notes: Map<string, ReportNotes>;
  subjectComments: Map<string, string>;
}> {
  const studentFilter = studentId ? tx`AND student_id = ${studentId}::uuid` : tx``;
  const rows = await tx<
    {
      student_id: string;
      teacher_comment: string | null;
      principal_comment: string | null;
      conduct_code: string | null;
      conduct_label: string | null;
      conduct_label_ar: string | null;
      attendance_from: string | null;
      attendance_to: string | null;
      attendance_days_recorded: number | null;
      attendance_days_present: number | null;
      attendance_days_absent: number | null;
      attendance_days_late: number | null;
      attendance_days_excused: number | null;
    }[]
  >`
    SELECT student_id, teacher_comment, principal_comment, conduct_code, conduct_label,
           conduct_label_ar, attendance_from::text AS attendance_from,
           attendance_to::text AS attendance_to, attendance_days_recorded,
           attendance_days_present, attendance_days_absent, attendance_days_late,
           attendance_days_excused
    FROM app.finalized_report_notes
    WHERE school_id = ${schoolId}::uuid AND finalization_id = ${finalizationId}::uuid
      ${studentFilter}
  `;
  const comments = await tx<{ student_id: string; subject_id: string; body: string }[]>`
    SELECT student_id, subject_id, body FROM app.finalized_subject_comments
    WHERE school_id = ${schoolId}::uuid AND finalization_id = ${finalizationId}::uuid
      ${studentFilter}
  `;
  const notes = new Map<string, ReportNotes>();
  for (const row of rows) {
    notes.set(row.student_id, {
      teacher_comment: row.teacher_comment,
      principal_comment: row.principal_comment,
      conduct:
        row.conduct_code && row.conduct_label
          ? { code: row.conduct_code, label: row.conduct_label, label_ar: row.conduct_label_ar }
          : null,
      attendance:
        row.attendance_from && row.attendance_to
          ? {
              from: row.attendance_from,
              to: row.attendance_to,
              days_recorded: row.attendance_days_recorded ?? 0,
              days_present: row.attendance_days_present ?? 0,
              days_absent: row.attendance_days_absent ?? 0,
              days_late: row.attendance_days_late ?? 0,
              days_excused: row.attendance_days_excused ?? 0,
            }
          : null,
    });
  }
  return {
    notes,
    subjectComments: new Map(
      comments.map((row) => [`${row.student_id}|${row.subject_id}`, row.body]),
    ),
  };
}
