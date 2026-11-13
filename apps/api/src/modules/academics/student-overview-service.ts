import { ERROR_CODES } from "@studafy/constants";
import { isFieldVisibleTo } from "@studafy/records";

import { CodedHttpException } from "../../coded-http-exception";
import { getStudentSubjectMarks } from "../grading/student-subject-service";
import { getSubjectRecords } from "../records/record-service";

import type { StudentSubjectMarks } from "../grading/student-subject-service";
import type { RecordEntryDto } from "../records/schemas";
import type { TransactionSql } from "postgres";

/**
 * The teacher's student page: one enrolled student, seen through one class the caller teaches.
 *
 * Everything is scoped to that class (its subject, section and term), read under the caller's own
 * row scope, and built from the services that own each part:
 *   - marks        the grading engine's live result for the class's subject in the section
 *                  (`getStudentSubjectMarks`, the mark sheet's computation), in the grade's
 *                  result format;
 *   - attendance   the student's records in this class's taken sessions this term (drafts and
 *                  cancelled sessions never count, as on the report card);
 *   - homework     the class's published assignments and the student's submission to each;
 *   - comments     the draft report-card notes for this subject (the term's and the annual one)
 *                  and the class teacher's overall comment;
 *   - records      the school's record fields whose visibility reaches teachers, through
 *                  `getSubjectRecords` with the "teachers" audience: sensitive fields (ID numbers,
 *                  medical notes...) are never returned, not even masked, and neither are
 *                  staff-only or finance fields or documents.
 *
 * Who: a teacher of the class (its lead teacher, or one timetabled to teach it -- `app.teaches_class`,
 * the rule the class's other teacher screens use), and only for a student actively enrolled in it.
 * School leadership has the full student record elsewhere; this page is the teaching view.
 */

export interface StudentOverview {
  class: {
    id: string;
    code: string;
    course_name: string;
    subject_id: string;
    subject_name: string;
    section_id: string | null;
    section_name: string | null;
    term_id: string;
    term_name: string;
  };
  student: {
    id: string;
    first_name: string;
    last_name: string;
    preferred_name: string | null;
    admission_number: string;
    enrolled_at: string;
  };
  marks: StudentSubjectMarks | null;
  /** Why `marks` is null: the class has no section, the subject has no grading setup, or the
   * student does not take the subject in the section's grading (e.g. an elective they left). */
  marks_unavailable: "no_section" | "not_configured" | "not_in_roster" | null;
  attendance: {
    sessions: number;
    present: number;
    absent: number;
    late: number;
    excused: number;
    remote: number;
    /** Most recent absences and late arrivals, newest first (at most 5). */
    recent: { session_date: string; status: "absent" | "late"; minutes_late: number | null }[];
  };
  homework: {
    total: number;
    handed_in: number;
    missing: number;
    upcoming: number;
    /** Newest due first (at most 20). */
    items: {
      id: string;
      title: string;
      due_at: string;
      max_score: number;
      status: "submitted" | "late" | "graded" | "returned" | "missing" | "upcoming";
      score: number | null;
      submitted_at: string | null;
    }[];
  };
  report_comments: {
    /** This term's comment in this subject. */
    term_subject_comment: string | null;
    /** The annual (certificate) comment in this subject. */
    annual_subject_comment: string | null;
    /** The class teacher's overall comment for this term. */
    term_teacher_comment: string | null;
  };
  records: {
    field_id: string;
    label_en: string;
    label_ar: string;
    value_en: string;
    value_ar: string;
  }[];
}

interface ClassRow {
  id: string;
  code: string;
  course_name: string;
  subject_id: string;
  subject_name: string;
  section_id: string | null;
  section_name: string | null;
  term_id: string;
  term_name: string;
  term_starts_on: string;
  term_ends_on: string;
}

function forbidden(): never {
  throw new CodedHttpException(403, ERROR_CODES.AUTHZ_FORBIDDEN, "You do not teach this class");
}

function notFound(message: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, message);
}

async function requireTaughtClass(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<ClassRow> {
  const [access] = await tx<{ teaches: boolean }[]>`
    SELECT app.teaches_class(${classId}::uuid) AS teaches
  `;
  // Not a teacher of the class: refused whether or not the caller can otherwise see it (row scope
  // already hides another teacher's class; leadership sees it but this is the teaching view).
  if (!access?.teaches) forbidden();
  const [row] = await tx<ClassRow[]>`
    SELECT class.id, class.code, course.name AS course_name, course.subject_id,
           subject.name AS subject_name, class.section_id, section.name AS section_name,
           class.term_id, term.name AS term_name,
           to_char(term.starts_on, 'YYYY-MM-DD') AS term_starts_on,
           to_char(term.ends_on, 'YYYY-MM-DD') AS term_ends_on
    FROM app.classes AS class
    JOIN app.courses AS course ON course.id = class.course_id AND course.school_id = class.school_id
    JOIN app.subjects AS subject
      ON subject.id = course.subject_id AND subject.school_id = course.school_id
    JOIN app.terms AS term ON term.id = class.term_id AND term.school_id = class.school_id
    LEFT JOIN app.sections AS section
      ON section.id = class.section_id AND section.school_id = class.school_id
    WHERE class.school_id = ${schoolId}::uuid AND class.id = ${classId}::uuid
  `;
  if (!row) notFound("Class not found");
  return row;
}

async function loadAttendance(
  tx: TransactionSql,
  schoolId: string,
  klass: ClassRow,
  studentId: string,
): Promise<StudentOverview["attendance"]> {
  // The student's records in this class's taken sessions this term. Draft and cancelled sessions
  // never count, as on the report card's attendance summary (report-card-service.ts). Read under
  // the caller's row scope: a teacher sees the sessions of the classes they teach.
  const entries = await tx<{ session_date: string; status: string; minutes_late: number | null }[]>`
    SELECT s.session_date::text AS session_date, r.status::text AS status, r.minutes_late
    FROM app.attendance_records AS r
    JOIN app.attendance_sessions AS s
      ON s.id = r.attendance_session_id AND s.school_id = r.school_id
     AND s.created_at = r.session_created_at
    WHERE r.school_id = ${schoolId}::uuid AND r.student_id = ${studentId}::uuid
      AND s.class_id = ${klass.id}::uuid
      AND s.session_date BETWEEN ${klass.term_starts_on}::date AND ${klass.term_ends_on}::date
      AND s.status NOT IN ('draft', 'cancelled')
    ORDER BY s.session_date DESC, s.period NULLS FIRST
  `;
  const count = (status: string) => entries.filter((entry) => entry.status === status).length;
  return {
    sessions: entries.length,
    present: count("present"),
    absent: count("absent"),
    late: count("late"),
    excused: count("excused"),
    remote: count("remote"),
    recent: entries
      .filter((entry) => entry.status === "absent" || entry.status === "late")
      .slice(0, 5)
      .map((entry) => ({
        session_date: entry.session_date,
        status: entry.status as "absent" | "late",
        minutes_late: entry.minutes_late === null ? null : Number(entry.minutes_late),
      })),
  };
}

async function loadHomework(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  studentId: string,
): Promise<StudentOverview["homework"]> {
  const rows = await tx<
    {
      id: string;
      title: string;
      due_at: Date;
      max_score: string;
      submission_status: string | null;
      is_late: boolean | null;
      score: string | null;
      submitted_at: Date | null;
    }[]
  >`
    SELECT assignment.id, assignment.title, assignment.due_at, assignment.max_score,
           submission.status::text AS submission_status, submission.is_late, submission.score,
           submission.submitted_at
    FROM app.assignments AS assignment
    LEFT JOIN app.assignment_submissions AS submission
      ON submission.assignment_id = assignment.id AND submission.school_id = assignment.school_id
     AND submission.student_id = ${studentId}::uuid
    WHERE assignment.school_id = ${schoolId}::uuid AND assignment.class_id = ${classId}::uuid
      AND assignment.status IN ('published', 'closed')
    ORDER BY assignment.due_at DESC, assignment.id
  `;
  const now = Date.now();
  const items = rows.map((row) => {
    const handedIn = ["submitted", "late", "graded", "returned"].includes(
      row.submission_status ?? "",
    );
    // A late hand-in is written as `submitted` with is_late (000050); older rows say `late`.
    const status: StudentOverview["homework"]["items"][number]["status"] = handedIn
      ? row.submission_status === "submitted" && row.is_late
        ? "late"
        : (row.submission_status as "submitted" | "late" | "graded" | "returned")
      : row.due_at.getTime() > now
        ? "upcoming"
        : "missing";
    return {
      id: row.id,
      title: row.title,
      due_at: row.due_at.toISOString(),
      max_score: Number(row.max_score),
      status,
      score: row.score === null ? null : Number(row.score),
      submitted_at: row.submitted_at?.toISOString() ?? null,
    };
  });
  return {
    total: items.length,
    handed_in: items.filter((item) => item.status !== "missing" && item.status !== "upcoming")
      .length,
    missing: items.filter((item) => item.status === "missing").length,
    upcoming: items.filter((item) => item.status === "upcoming").length,
    items: items.slice(0, 20),
  };
}

async function loadReportComments(
  tx: TransactionSql,
  schoolId: string,
  klass: ClassRow,
  studentId: string,
): Promise<StudentOverview["report_comments"]> {
  if (klass.section_id === null) {
    return { term_subject_comment: null, annual_subject_comment: null, term_teacher_comment: null };
  }
  const comments = await tx<{ term_id: string | null; body: string }[]>`
    SELECT term_id, body FROM app.report_subject_comments
    WHERE school_id = ${schoolId}::uuid AND section_id = ${klass.section_id}::uuid
      AND student_id = ${studentId}::uuid AND subject_id = ${klass.subject_id}::uuid
      AND (term_id IS NULL OR term_id = ${klass.term_id}::uuid)
  `;
  const [note] = await tx<{ teacher_comment: string | null }[]>`
    SELECT teacher_comment FROM app.report_student_notes
    WHERE school_id = ${schoolId}::uuid AND section_id = ${klass.section_id}::uuid
      AND student_id = ${studentId}::uuid AND term_id = ${klass.term_id}::uuid
  `;
  return {
    term_subject_comment: comments.find((row) => row.term_id === klass.term_id)?.body ?? null,
    annual_subject_comment: comments.find((row) => row.term_id === null)?.body ?? null,
    term_teacher_comment: note?.teacher_comment ?? null,
  };
}

function yesNo(answer: boolean, lang: "en" | "ar"): string {
  if (lang === "ar") return answer ? "نعم" : "لا";
  return answer ? "Yes" : "No";
}

/** A record answer as text in one language: choice values become their labels. */
function recordText(entry: RecordEntryDto, lang: "en" | "ar"): string | null {
  const value = entry.value;
  if (value === null || value === undefined) return null;
  const { field } = entry;
  const labelOf = (key: string) => {
    const option = field.options.find((candidate) => candidate.value === key);
    if (!option) return key;
    return lang === "ar" ? option.label_ar || option.label_en : option.label_en;
  };
  if (field.field_type === "yes_no") {
    return typeof value === "boolean" ? yesNo(value, lang) : null;
  }
  if (Array.isArray(value)) {
    const labels = value.map((item) => labelOf(String(item)));
    return labels.length === 0 ? null : labels.join(lang === "ar" ? "، " : ", ");
  }
  if (field.field_type === "single_choice") return labelOf(String(value));
  const text = String(value).trim();
  return text === "" ? null : text;
}

async function loadRecords(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentOverview["records"]> {
  const records = await getSubjectRecords(
    tx,
    schoolId,
    { kind: "student", id: studentId },
    "teachers",
  );
  return records.entries
    .filter(
      (entry) =>
        !entry.archived &&
        !entry.masked &&
        entry.field.field_type !== "document" &&
        // Belt and braces: the "teachers" audience already drops these.
        isFieldVisibleTo(entry.field, "teachers"),
    )
    .flatMap((entry) => {
      const en = recordText(entry, "en");
      const ar = recordText(entry, "ar");
      if (en === null || ar === null) return [];
      return [
        {
          field_id: entry.field.id,
          label_en: entry.field.label_en,
          label_ar: entry.field.label_ar || entry.field.label_en,
          value_en: en,
          value_ar: ar,
        },
      ];
    });
}

export async function getStudentOverview(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
  studentId: string,
  options: { includeRecords: boolean },
): Promise<StudentOverview> {
  const klass = await requireTaughtClass(tx, schoolId, classId);

  const [student] = await tx<
    {
      id: string;
      first_name: string;
      last_name: string;
      preferred_name: string | null;
      admission_number: string;
      enrolled_at: Date;
    }[]
  >`
    SELECT student.id, student.first_name, student.last_name, student.preferred_name,
           student.admission_number, enrollment.enrolled_at
    FROM app.enrollments AS enrollment
    JOIN app.students AS student
      ON student.id = enrollment.student_id AND student.school_id = enrollment.school_id
    WHERE enrollment.school_id = ${schoolId}::uuid AND enrollment.class_id = ${classId}::uuid
      AND enrollment.student_id = ${studentId}::uuid AND enrollment.status = 'active'
  `;
  if (!student) notFound("This student is not enrolled in this class");

  let marks: StudentSubjectMarks | null = null;
  let marksUnavailable: StudentOverview["marks_unavailable"] = null;
  if (klass.section_id === null) {
    marksUnavailable = "no_section";
  } else {
    const result = await getStudentSubjectMarks(
      tx,
      schoolId,
      klass.section_id,
      klass.subject_id,
      studentId,
      klass.term_id,
    );
    if (typeof result === "string") marksUnavailable = result;
    else marks = result;
  }

  const attendance = await loadAttendance(tx, schoolId, klass, studentId);
  const homework = await loadHomework(tx, schoolId, classId, studentId);
  const reportComments = await loadReportComments(tx, schoolId, klass, studentId);
  const records = options.includeRecords ? await loadRecords(tx, schoolId, studentId) : [];

  return {
    class: {
      id: klass.id,
      code: klass.code,
      course_name: klass.course_name,
      subject_id: klass.subject_id,
      subject_name: klass.subject_name,
      section_id: klass.section_id,
      section_name: klass.section_name,
      term_id: klass.term_id,
      term_name: klass.term_name,
    },
    student: {
      id: student.id,
      first_name: student.first_name,
      last_name: student.last_name,
      preferred_name: student.preferred_name,
      admission_number: student.admission_number,
      enrolled_at: student.enrolled_at.toISOString(),
    },
    marks,
    marks_unavailable: marksUnavailable,
    attendance,
    homework,
    report_comments: reportComments,
    records,
  };
}
