/**
 * The dry-run diff: what migrating a staged import would do to live data, row by row.
 *
 * Shared by the API's preview and the worker's migration so both classify every row identically.
 * The worker re-plans inside its migration transaction rather than trusting a preview computed
 * earlier, so a record changed between preview and commit is judged against what is live then.
 *
 * Reads are set-based (two queries for the whole import) and assume the caller's transaction sees
 * every student in the school: an admin's tenant transaction or a system one. Under a narrower role
 * scope, students it cannot see would be planned as creates and then fail on the unique key.
 *
 * Parents are never matched (docs/modules/finance-module-guide.md "How parents and children get
 * linked"). A parent_email that already belongs to an account in the school is not looked up and
 * linked: the student is still imported, with no link and a PARENT_ACCOUNT_EXISTS parent conflict,
 * and staff link the parent themselves from the Guardians tab or Finance > Unlinked. A new
 * parent_email creates a new parent and household, once per file: every later line naming the
 * same new email is a sibling of the first and joins that parent.
 */

import { normalizeAdmissionNumber, normalizeEmail } from "./record";

import type { StudentImportRecord } from "./record";
import type { TransactionSql } from "postgres";

export type StudentImportAction = "create" | "update" | "unchanged" | "conflict";

/**
 * Why a row cannot be applied. Conflict rows are skipped by the migration and reported; they never
 * fail the import, because each needs a human decision the file cannot express.
 */
export type StudentImportConflict =
  /** An earlier line in the same file already has this admission number. */
  | "DUPLICATE_ADMISSION_NUMBER_IN_FILE"
  /** An earlier line in the same file gives this email to a different admission number. */
  | "DUPLICATE_EMAIL_IN_FILE"
  /** The admission number exists, but its student signs in with a different email. An import never
   * changes a login email. */
  | "EMAIL_MISMATCH"
  /** A new admission number whose email already belongs to another student. */
  | "EMAIL_BELONGS_TO_OTHER_STUDENT"
  /** The email belongs to a staff account; making it a student would grant it the STUDENT role. */
  | "EMAIL_BELONGS_TO_STAFF"
  /** The parent email is the email of a new student created by this same file. */
  | "PARENT_EMAIL_BELONGS_TO_STUDENT";

/**
 * Why a row's parent is not linked, while the student itself is still imported. Only one reason
 * today: the email already belongs to an account, which an import never matches people on.
 */
export type StudentImportParentConflict = "PARENT_ACCOUNT_EXISTS";

/** Student columns an import may change on an existing student. */
export const UPDATABLE_STUDENT_FIELDS = [
  "first_name",
  "middle_name",
  "last_name",
  "preferred_name",
  "date_of_birth",
  "status",
] as const;

export type UpdatableStudentField = (typeof UPDATABLE_STUDENT_FIELDS)[number];

export interface FieldChange {
  from: string | null;
  to: string;
}

export interface PlannedRow {
  line_number: number;
  record: StudentImportRecord;
  action: StudentImportAction;
  conflict: StudentImportConflict | null;
  /** Live student fields this row changes. Empty for creates, which change nothing that exists. */
  changes: Partial<Record<UpdatableStudentField, FieldChange>>;
  /**
   * The parent outcome. "create": this line creates the new parent and household. "sibling": an
   * earlier line in this file creates them, and this student joins. "conflict": not linked (see
   * parent_conflict). Null when the row names no parent.
   */
  parent: "create" | "sibling" | "conflict" | null;
  parent_conflict: StudentImportParentConflict | null;
  /** The line that creates this row's parent (itself for "create"); null otherwise. */
  parent_group_line: number | null;
  /** Whether a parent-student link is created. Null when no link will be made. */
  link: "create" | null;
  /** The live student this row matched, when it matched one. */
  student_id: string | null;
  /** The live account the student's email belongs to, when one exists. */
  user_id: string | null;
}

export interface StudentImportPlanTotals {
  create: number;
  update: number;
  unchanged: number;
  conflict: number;
  parents_created: number;
  links_created: number;
  /** Rows whose parent will not be linked (PARENT_ACCOUNT_EXISTS). Staff link them by hand. */
  parent_conflicts: number;
}

export interface StudentImportPlan {
  rows: PlannedRow[];
  totals: StudentImportPlanTotals;
}

export interface StagedRecord {
  line_number: number;
  record: StudentImportRecord;
}

interface LiveStudent {
  id: string;
  user_id: string;
  normalized_admission_number: string;
  normalized_email: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  status: string;
}

interface LiveUser {
  id: string;
  normalized_email: string;
  is_student: boolean;
  is_staff: boolean;
}

/** Roles that do not make an account "staff" for EMAIL_BELONGS_TO_STAFF. */
const NON_STAFF_ROLES = ["STUDENT", "PARENT", "GUEST"];

export async function planStudentImport(
  tx: TransactionSql,
  schoolId: string,
  staged: readonly StagedRecord[],
): Promise<StudentImportPlan> {
  const records = [...staged].sort((a, b) => a.line_number - b.line_number);
  const live = await loadLiveData(tx, schoolId, records);

  const studentEmailsInFile = new Set(records.map(({ record }) => normalizeEmail(record.email)));
  const seenAdmissions = new Set<string>();
  const emailOwners = new Map<string, string>();
  /** New parent email -> the line that creates that parent. */
  const parentsCreatedInFile = new Map<string, number>();

  const rows = records.map(({ line_number, record }): PlannedRow => {
    const admission = normalizeAdmissionNumber(record.admission_number);
    const email = normalizeEmail(record.email);
    const student = live.students.get(admission) ?? null;
    const user = live.users.get(email) ?? null;
    const parentEmail = record.parent_email === null ? null : normalizeEmail(record.parent_email);
    const parentUser = parentEmail === null ? null : (live.users.get(parentEmail) ?? null);

    const row: PlannedRow = {
      line_number,
      record,
      action: "conflict",
      conflict: null,
      changes: {},
      parent: null,
      parent_conflict: null,
      parent_group_line: null,
      link: null,
      student_id: student?.id ?? null,
      user_id: student?.user_id ?? user?.id ?? null,
    };

    const firstOwner = emailOwners.get(email);
    if (!emailOwners.has(email)) emailOwners.set(email, admission);

    if (seenAdmissions.has(admission)) {
      row.conflict = "DUPLICATE_ADMISSION_NUMBER_IN_FILE";
    } else if (firstOwner !== undefined && firstOwner !== admission) {
      row.conflict = "DUPLICATE_EMAIL_IN_FILE";
    } else if (student && student.normalized_email !== email) {
      row.conflict = "EMAIL_MISMATCH";
    } else if (!student && user?.is_student) {
      row.conflict = "EMAIL_BELONGS_TO_OTHER_STUDENT";
    } else if (!student && user?.is_staff) {
      row.conflict = "EMAIL_BELONGS_TO_STAFF";
    } else if (parentEmail !== null && !parentUser && studentEmailsInFile.has(parentEmail)) {
      // A new account this file is about to create for a student cannot also be the new parent.
      // A live account (student or not) is PARENT_ACCOUNT_EXISTS below, and the row still imports.
      row.conflict = "PARENT_EMAIL_BELONGS_TO_STUDENT";
    }
    seenAdmissions.add(admission);
    if (row.conflict) return row;

    if (student) row.changes = diffStudent(student, record);

    if (parentEmail !== null) {
      const creatingLine = parentsCreatedInFile.get(parentEmail);
      if (parentUser) {
        row.parent = "conflict";
        row.parent_conflict = "PARENT_ACCOUNT_EXISTS";
      } else if (creatingLine !== undefined) {
        row.parent = "sibling";
        row.parent_group_line = creatingLine;
        row.link = "create";
      } else {
        row.parent = "create";
        row.parent_group_line = line_number;
        row.link = "create";
        parentsCreatedInFile.set(parentEmail, line_number);
      }
    }

    // Template answers are written for an existing student whenever the file gives any: whether
    // they differ is only knowable by opening sealed values, which the plan never does.
    const writesRecords = Object.keys(record.records ?? {}).length > 0;
    row.action = !student
      ? "create"
      : Object.keys(row.changes).length > 0 || row.link === "create" || writesRecords
        ? "update"
        : "unchanged";
    return row;
  });

  return { rows, totals: totalsOf(rows) };
}

function diffStudent(
  student: LiveStudent,
  record: StudentImportRecord,
): Partial<Record<UpdatableStudentField, FieldChange>> {
  const changes: Partial<Record<UpdatableStudentField, FieldChange>> = {};
  for (const field of UPDATABLE_STUDENT_FIELDS) {
    const next = record[field] ?? null;
    if (next !== null && next !== student[field]) {
      changes[field] = { from: student[field], to: next };
    }
  }
  return changes;
}

function totalsOf(rows: readonly PlannedRow[]): StudentImportPlanTotals {
  const totals: StudentImportPlanTotals = {
    create: 0,
    update: 0,
    unchanged: 0,
    conflict: 0,
    parents_created: 0,
    links_created: 0,
    parent_conflicts: 0,
  };
  for (const row of rows) {
    totals[row.action]++;
    if (row.parent === "create") totals.parents_created++;
    if (row.link === "create") totals.links_created++;
    if (row.parent_conflict !== null) totals.parent_conflicts++;
  }
  return totals;
}

async function loadLiveData(
  tx: TransactionSql,
  schoolId: string,
  records: readonly StagedRecord[],
): Promise<{
  students: Map<string, LiveStudent>;
  users: Map<string, LiveUser>;
}> {
  const admissions = [
    ...new Set(records.map((r) => normalizeAdmissionNumber(r.record.admission_number))),
  ];
  const emails = [
    ...new Set(
      records.flatMap(({ record }) =>
        record.parent_email === null
          ? [normalizeEmail(record.email)]
          : [normalizeEmail(record.email), normalizeEmail(record.parent_email)],
      ),
    ),
  ];

  const students = await tx<LiveStudent[]>`
    SELECT s.id, s.user_id, s.normalized_admission_number, u.normalized_email,
           s.first_name, s.middle_name, s.last_name, s.preferred_name,
           s.date_of_birth::text AS date_of_birth, s.status::text AS status
    FROM app.students AS s
    JOIN app.users AS u ON u.id = s.user_id AND u.school_id = s.school_id
    WHERE s.school_id = ${schoolId}::uuid
      AND s.normalized_admission_number = ANY(${tx.array(admissions)}::text[])
  `;

  const users = await tx<LiveUser[]>`
    SELECT u.id, u.normalized_email,
           EXISTS (
             SELECT 1 FROM app.students AS s
             WHERE s.school_id = u.school_id AND s.user_id = u.id
           ) AS is_student,
           EXISTS (
             SELECT 1 FROM app.user_roles AS ur
             WHERE ur.school_id = u.school_id AND ur.user_id = u.id
               AND ur.role::text <> ALL(${tx.array(NON_STAFF_ROLES)}::text[])
           ) AS is_staff
    FROM app.users AS u
    WHERE u.school_id = ${schoolId}::uuid
      AND u.normalized_email = ANY(${tx.array(emails)}::text[])
  `;

  return {
    students: new Map(students.map((s) => [s.normalized_admission_number, s])),
    // The parent emails are looked up only to refuse them (PARENT_ACCOUNT_EXISTS), never to link.
    users: new Map(users.map((u) => [u.normalized_email, u])),
  };
}
