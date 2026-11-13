/**
 * The dry-run diff: what migrating a staged import would do to live data, row by row.
 *
 * Shared by the API's preview and the worker's migration so both classify every row identically.
 * The worker re-plans inside its migration transaction rather than trusting a preview computed
 * earlier, so a record changed between preview and commit is judged against what is live then.
 *
 * Reads are set-based (a handful of queries for the whole import) and assume the caller's
 * transaction sees every student in the school: an admin's tenant transaction or a system one.
 * Under a narrower role scope, students it cannot see would be planned as creates and then fail on
 * the unique key.
 *
 * EMAIL IS OPTIONAL. A student or parent without one signs in with the member ID issued to them
 * (000140) and a password set from a one-time setup code (000141, 000184). Email checks below apply
 * only to lines that give one.
 *
 * PARENTS ARE NEVER MATCHED (docs/modules/finance-module-guide.md "How parents and children get
 * linked"). A parent email that already belongs to an account in the school is not looked up and
 * linked: the student is still imported, with that parent unlinked (PARENT_ACCOUNT_EXISTS), and
 * staff link them by hand. Which lines share a NEW parent is said by the file itself:
 *   - with a `family` value, every line of that family shares its parent 1 and its parent 2, each
 *     created from the first line of the family that names it. A line of the family that leaves
 *     the parent blank still joins, with the relationship the naming line gave;
 *   - without one, lines naming the same new parent email share that parent (the pre-family rule);
 *   - a parent with neither is new on every line.
 * The family number is the school's statement that those children are siblings -- a link staff
 * chose, not one inferred from names or phone numbers -- and it is never stored.
 *
 * A student who already has a parent in the school gets no new parents from an import ("kept"), so
 * re-importing a file never creates duplicate parents.
 *
 * PLACEMENT. `grade` and `section` name a section of the current academic year (the active one,
 * else the one being planned). Names are matched case- and spacing-insensitively; a grade with a
 * single section needs no section column. Nothing is created: an unknown grade or section is a
 * placement conflict, and the student is imported unplaced.
 */

import { normalizeAdmissionNumber, normalizeEmail, PARENT_SLOTS } from "./record";

import type { ParentRelationship } from "./fields";
import type { ParentSlot, StudentImportRecord } from "./record";
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
 * Why one of a row's parents is not linked, while the student itself is still imported.
 * PARENT_ACCOUNT_EXISTS: the email already belongs to an account, which an import never matches
 * people on. PARENT_EMAIL_IN_OTHER_FAMILY: an earlier family in this file already creates a parent
 * with this email, and one account cannot be created twice.
 */
export type StudentImportParentConflict = "PARENT_ACCOUNT_EXISTS" | "PARENT_EMAIL_IN_OTHER_FAMILY";

/** Why a row's student is imported without being placed in a section. */
export type StudentImportPlacementConflict =
  /** The school has no active or planned academic year to place students in. */
  | "NO_ACADEMIC_YEAR"
  /** No grade of that name has a section in the current academic year. */
  | "GRADE_NOT_FOUND"
  /** The grade has no section of that name in the current academic year. */
  | "SECTION_NOT_FOUND"
  /** No section was given, and the grade has more than one section to choose from. */
  | "SECTION_REQUIRED";

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

/**
 * One parent of one row. "create": this line creates the parent (and, for the line's first
 * parent, its household). "sibling": an earlier line creates them (parent_group_line) and this
 * student joins. "conflict": not linked (see parent_conflict). "kept": the student already has a
 * parent in the school, so the import adds none.
 */
export type PlannedParentOutcome = "create" | "sibling" | "conflict" | "kept";

export interface PlannedParent {
  parent: PlannedParentOutcome;
  parent_conflict: StudentImportParentConflict | null;
  /** The line whose details create this parent (itself for "create"); null otherwise. */
  parent_group_line: number | null;
  /** Whether a parent-student link is created. Null when no link will be made. */
  link: "create" | null;
  /** The link's relationship: this line's, or the naming line's for a blank family line. */
  relationship: ParentRelationship | null;
}

export interface PlannedPlacement {
  section_id: string;
  academic_year_id: string;
  /** place: the student has no section this year. move: from another section. unchanged. */
  action: "place" | "move" | "unchanged";
}

export interface PlannedRow {
  line_number: number;
  record: StudentImportRecord;
  action: StudentImportAction;
  conflict: StudentImportConflict | null;
  /** Live student fields this row changes. Empty for creates, which change nothing that exists. */
  changes: Partial<Record<UpdatableStudentField, FieldChange>>;
  /** Parent 1's outcome, flat for the API's long-standing fields. Null when it names no parent 1. */
  parent: PlannedParentOutcome | null;
  parent_conflict: StudentImportParentConflict | null;
  parent_group_line: number | null;
  link: "create" | null;
  /** Parent 1's plan as a whole (the flat fields above, plus the relationship). */
  parent1: PlannedParent | null;
  /** Parent 2's outcome; null when the row names no parent 2. */
  parent2: PlannedParent | null;
  /** Where the student is placed; null when the row names no grade or it cannot be resolved. */
  placement: PlannedPlacement | null;
  placement_conflict: StudentImportPlacementConflict | null;
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
  /** New parent accounts, parent 1 and parent 2 alike. */
  parents_created: number;
  links_created: number;
  /** Parents that will not be linked (a conflict on either slot). Staff link them by hand. */
  parent_conflicts: number;
  /** Students placed in, or moved to, a section. */
  placed: number;
  /** Rows whose student is imported unplaced (see placement_conflict). */
  placement_conflicts: number;
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
  normalized_email: string | null;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: string | null;
  status: string;
  has_parent: boolean;
}

interface LiveUser {
  id: string;
  normalized_email: string;
  is_student: boolean;
  is_staff: boolean;
}

interface LiveSection {
  id: string;
  name: string;
  grade_name: string;
}

interface LivePlacement {
  academic_year_id: string | null;
  /** Grade name key -> its sections this year. */
  grades: Map<string, LiveSection[]>;
  /** Student id -> their section this year. */
  current: Map<string, string>;
}

/** Roles that do not make an account "staff" for EMAIL_BELONGS_TO_STAFF. */
const NON_STAFF_ROLES = ["STUDENT", "PARENT", "GUEST"];

/** Case-, width- and spacing-insensitive key for a grade, section or family name. */
export function nameKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function planStudentImport(
  tx: TransactionSql,
  schoolId: string,
  staged: readonly StagedRecord[],
): Promise<StudentImportPlan> {
  const records = [...staged].sort((a, b) => a.line_number - b.line_number);
  const live = await loadLiveData(tx, schoolId, records);

  const studentEmailsInFile = new Set(
    records.flatMap(({ record }) => (record.email === null ? [] : [normalizeEmail(record.email)])),
  );
  const seenAdmissions = new Set<string>();
  const emailOwners = new Map<string, string>();

  // Pass 1: whether each line can be applied at all.
  const rows = records.map(({ line_number, record }): PlannedRow => {
    const admission = normalizeAdmissionNumber(record.admission_number);
    const email = record.email === null ? null : normalizeEmail(record.email);
    const student = live.students.get(admission) ?? null;
    const user = email === null ? null : (live.users.get(email) ?? null);

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
      parent1: null,
      parent2: null,
      placement: null,
      placement_conflict: null,
      student_id: student?.id ?? null,
      user_id: student?.user_id ?? user?.id ?? null,
    };

    const firstOwner = email === null ? undefined : emailOwners.get(email);
    if (email !== null && firstOwner === undefined) emailOwners.set(email, admission);

    const newParentEmailOfStudent = PARENT_SLOTS.some((slot) => {
      const parentEmail = record[slot.email];
      if (parentEmail === null) return false;
      const normalized = normalizeEmail(parentEmail);
      return !live.users.has(normalized) && studentEmailsInFile.has(normalized);
    });

    if (seenAdmissions.has(admission)) {
      row.conflict = "DUPLICATE_ADMISSION_NUMBER_IN_FILE";
    } else if (firstOwner !== undefined && firstOwner !== admission) {
      row.conflict = "DUPLICATE_EMAIL_IN_FILE";
    } else if (student && email !== null && student.normalized_email !== email) {
      row.conflict = "EMAIL_MISMATCH";
    } else if (!student && user?.is_student) {
      row.conflict = "EMAIL_BELONGS_TO_OTHER_STUDENT";
    } else if (!student && user?.is_staff) {
      row.conflict = "EMAIL_BELONGS_TO_STAFF";
    } else if (newParentEmailOfStudent) {
      // A new account this file is about to create for a student cannot also be a new parent.
      // A live account (student or not) is PARENT_ACCOUNT_EXISTS below, and the row still imports.
      row.conflict = "PARENT_EMAIL_BELONGS_TO_STUDENT";
    }
    seenAdmissions.add(admission);
    if (row.conflict) return row;

    if (student) row.changes = diffStudent(student, record);
    planPlacement(row, record, student, live.placement);
    return row;
  });

  const sound = rows.filter((row) => row.conflict === null);
  const keeps = (row: PlannedRow) =>
    row.student_id !== null &&
    (live.students.get(normalizeAdmissionNumber(row.record.admission_number))?.has_parent ?? false);

  // Pass 2: the parents each line names, and which line creates each shared parent.
  const groups = new Map<string, { line: number; relationship: ParentRelationship | null }>();
  const newParentEmails = new Map<string, string>();
  const plans = new Map<PlannedRow, (PlannedParent | null)[]>();
  for (const row of sound) {
    plans.set(
      row,
      PARENT_SLOTS.map((slot, index) =>
        planNamedParent(row, slot, index, keeps(row), live.users, groups, newParentEmails),
      ),
    );
  }

  // Pass 3: lines of a family that leave a parent blank join the parent the family names.
  for (const row of sound) {
    const family = row.record.family;
    const slots = plans.get(row)!;
    if (family === null || keeps(row)) continue;
    PARENT_SLOTS.forEach((_, index) => {
      if (slots[index] !== null) return;
      const group = groups.get(familyGroup(family, index));
      if (!group) return;
      slots[index] = {
        parent: "sibling",
        parent_conflict: null,
        parent_group_line: group.line,
        link: "create",
        relationship: group.relationship,
      };
    });
  }

  for (const row of sound) {
    const [first, second] = plans.get(row)!;
    row.parent1 = first ?? null;
    row.parent2 = second ?? null;
    if (first) {
      row.parent = first.parent;
      row.parent_conflict = first.parent_conflict;
      row.parent_group_line = first.parent_group_line;
      row.link = first.link;
    }

    // Template answers are written for an existing student whenever the file gives any: whether
    // they differ is only knowable by opening sealed values, which the plan never does.
    const writesRecords = Object.keys(row.record.records ?? {}).length > 0;
    const links = row.parent1?.link === "create" || row.parent2?.link === "create";
    const places = row.placement !== null && row.placement.action !== "unchanged";
    row.action =
      row.student_id === null
        ? "create"
        : Object.keys(row.changes).length > 0 || links || writesRecords || places
          ? "update"
          : "unchanged";
  }

  return { rows, totals: totalsOf(rows) };
}

function familyGroup(family: string, slotIndex: number): string {
  return `family:${nameKey(family)}:${slotIndex}`;
}

/**
 * The parent a sound line names in one slot, or null when it names none there. The first line of a
 * group (a family's slot, else a new email) creates the parent; later lines join it.
 */
function planNamedParent(
  row: PlannedRow,
  slot: ParentSlot,
  slotIndex: number,
  keep: boolean,
  liveUsers: ReadonlyMap<string, LiveUser>,
  groups: Map<string, { line: number; relationship: ParentRelationship | null }>,
  newParentEmails: Map<string, string>,
): PlannedParent | null {
  const { record, line_number: line } = row;
  const rawEmail = record[slot.email];
  if (rawEmail === null && record[slot.name] === null) return null;
  const parentEmail = rawEmail === null ? null : normalizeEmail(rawEmail);
  const unlinked = {
    parent_conflict: null,
    parent_group_line: null,
    link: null,
    relationship: null,
  };

  if (parentEmail !== null && liveUsers.has(parentEmail)) {
    return { ...unlinked, parent: "conflict", parent_conflict: "PARENT_ACCOUNT_EXISTS" };
  }
  if (keep) return { ...unlinked, parent: "kept" };

  const group =
    record.family !== null
      ? familyGroup(record.family, slotIndex)
      : parentEmail !== null
        ? `email:${parentEmail}`
        : `line:${line}:${slotIndex}`;
  const relationship = record[slot.relationship];
  const existing = groups.get(group);
  if (existing !== undefined) {
    return {
      parent: "sibling",
      parent_conflict: null,
      parent_group_line: existing.line,
      link: "create",
      relationship,
    };
  }
  if (parentEmail !== null) {
    const claimedBy = newParentEmails.get(parentEmail);
    if (claimedBy !== undefined && claimedBy !== group) {
      return { ...unlinked, parent: "conflict", parent_conflict: "PARENT_EMAIL_IN_OTHER_FAMILY" };
    }
    newParentEmails.set(parentEmail, group);
  }
  groups.set(group, { line, relationship });
  return {
    parent: "create",
    parent_conflict: null,
    parent_group_line: line,
    link: "create",
    relationship,
  };
}

function planPlacement(
  row: PlannedRow,
  record: StudentImportRecord,
  student: LiveStudent | null,
  live: LivePlacement,
): void {
  if (record.grade === null) return;
  if (live.academic_year_id === null) {
    row.placement_conflict = "NO_ACADEMIC_YEAR";
    return;
  }
  const sections = live.grades.get(nameKey(record.grade));
  if (!sections) {
    row.placement_conflict = "GRADE_NOT_FOUND";
    return;
  }
  let section: LiveSection | undefined;
  if (record.section === null) {
    if (sections.length !== 1) {
      row.placement_conflict = "SECTION_REQUIRED";
      return;
    }
    section = sections[0];
  } else {
    const wanted = nameKey(record.section);
    section = sections.find((candidate) => nameKey(candidate.name) === wanted);
  }
  if (!section) {
    row.placement_conflict = "SECTION_NOT_FOUND";
    return;
  }
  const current = student ? live.current.get(student.id) : undefined;
  row.placement = {
    section_id: section.id,
    academic_year_id: live.academic_year_id,
    action: current === undefined ? "place" : current === section.id ? "unchanged" : "move",
  };
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
    placed: 0,
    placement_conflicts: 0,
  };
  for (const row of rows) {
    totals[row.action]++;
    for (const parent of [row.parent1, row.parent2]) {
      if (parent === null) continue;
      if (parent.parent === "create") totals.parents_created++;
      if (parent.link === "create") totals.links_created++;
      if (parent.parent_conflict !== null) totals.parent_conflicts++;
    }
    if (row.placement !== null && row.placement.action !== "unchanged") totals.placed++;
    if (row.placement_conflict !== null) totals.placement_conflicts++;
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
  placement: LivePlacement;
}> {
  const admissions = [
    ...new Set(records.map((r) => normalizeAdmissionNumber(r.record.admission_number))),
  ];
  const emails = [
    ...new Set(
      records.flatMap(({ record }) =>
        [record.email, record.parent_email, record.parent2_email].flatMap((value) =>
          value === null ? [] : [normalizeEmail(value)],
        ),
      ),
    ),
  ];

  const students = await tx<LiveStudent[]>`
    SELECT s.id, s.user_id, s.normalized_admission_number, u.normalized_email,
           s.first_name, s.middle_name, s.last_name, s.preferred_name,
           s.date_of_birth::text AS date_of_birth, s.status::text AS status,
           EXISTS (
             SELECT 1 FROM app.parent_child_links AS pcl
             WHERE pcl.school_id = s.school_id AND pcl.student_id = s.id
           ) AS has_parent
    FROM app.students AS s
    JOIN app.users AS u ON u.id = s.user_id AND u.school_id = s.school_id
    WHERE s.school_id = ${schoolId}::uuid
      AND s.normalized_admission_number = ANY(${tx.array(admissions)}::text[])
  `;

  const users =
    emails.length === 0
      ? []
      : await tx<LiveUser[]>`
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

  const wantsPlacement = records.some(({ record }) => record.grade !== null);
  const placement = wantsPlacement
    ? await loadPlacement(
        tx,
        schoolId,
        students.map((s) => s.id),
      )
    : { academic_year_id: null, grades: new Map(), current: new Map() };

  return {
    students: new Map(students.map((s) => [s.normalized_admission_number, s])),
    // The parent emails are looked up only to refuse them (PARENT_ACCOUNT_EXISTS), never to link.
    users: new Map(users.map((u) => [u.normalized_email, u])),
    placement,
  };
}

/**
 * The academic year students are placed into -- the active one, else the one being planned (a
 * school setting up before term starts) -- with its sections by grade, and where the file's
 * existing students sit in it now.
 */
async function loadPlacement(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
): Promise<LivePlacement> {
  const [year] = await tx<{ id: string }[]>`
    SELECT id FROM app.academic_years
    WHERE school_id = ${schoolId}::uuid AND status IN ('active', 'planned')
    ORDER BY (status = 'active') DESC,
             (CURRENT_DATE BETWEEN starts_on AND ends_on) DESC,
             starts_on ASC
    LIMIT 1
  `;
  if (!year) return { academic_year_id: null, grades: new Map(), current: new Map() };

  const sections = await tx<LiveSection[]>`
    SELECT s.id, s.name, g.name AS grade_name
    FROM app.sections AS s
    JOIN app.grade_levels AS g ON g.id = s.grade_level_id AND g.school_id = s.school_id
    WHERE s.school_id = ${schoolId}::uuid AND s.academic_year_id = ${year.id}::uuid
    ORDER BY g.sort_order, s.name
  `;
  const grades = new Map<string, LiveSection[]>();
  for (const section of sections) {
    const key = nameKey(section.grade_name);
    grades.set(key, [...(grades.get(key) ?? []), section]);
  }

  const current =
    studentIds.length === 0
      ? []
      : await tx<{ student_id: string; section_id: string }[]>`
          SELECT student_id, section_id FROM app.student_sections
          WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${year.id}::uuid
            AND student_id = ANY(${tx.array(studentIds as string[])}::uuid[])
        `;

  return {
    academic_year_id: year.id,
    grades,
    current: new Map(current.map((row) => [row.student_id, row.section_id])),
  };
}
