import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { assertCanReadStudent } from "../external-exams/service";

import { detectExamClashes } from "./clashes";
import { generateSeating, planSeatMove } from "./seating";

import type { ClashSlot, ExamClash } from "./clashes";
import type { EXAM_PERIOD_KINDS, EXAM_PERIOD_STATUSES } from "./schemas";
import type { Seat, SeatingRoom, SeatingStrategy } from "./seating";
import type { TransactionSql } from "postgres";

/**
 * Exam weeks (000265): exam periods, their timetable of exam slots, the rooms each slot sits in,
 * seating and invigilators.
 *
 * School leadership (timetable:manage) builds and reads all of it. Students and linked parents read
 * a student's exam timetable -- the slots of published periods the student sits, with their room
 * and seat -- through app.can_read_student, and a teacher reads their own invigilation duties in
 * published periods. Dates and times are the school's wall clock; the apps get the school's
 * timezone beside them.
 *
 * Who sits a slot: the students placed in its sections that year, less those exempt from the
 * subject, and for an optional or elective subject only those enrolled in it -- the same rule mark
 * sheets use (engine-config.ts toRoster). A subject with no grading configuration for the grade is
 * treated as taken by everyone; one excluded for a section, by nobody in it.
 */

type ExamPeriodKind = (typeof EXAM_PERIOD_KINDS)[number];
type ExamPeriodStatus = (typeof EXAM_PERIOD_STATUSES)[number];

const DEFAULT_TIMEZONE = "Africa/Casablanca";

// ---------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------

export interface IdName {
  id: string;
  name: string;
}

export interface SubjectRef {
  id: string;
  code: string;
  name: string;
}

export interface RoomRef {
  id: string;
  code: string;
  name: string;
  building: string | null;
  floor: string | null;
}

export interface ExamPeriodSummaryView {
  id: string;
  academic_year_id: string;
  term: IdName | null;
  name: string;
  kind: ExamPeriodKind;
  starts_on: string;
  ends_on: string;
  status: ExamPeriodStatus;
  published_at: string | null;
  grade_levels: IdName[];
  slot_count: number;
  created_at: string;
  updated_at: string;
}

export interface ExamSlotRoomView extends RoomRef {
  capacity: number | null;
  seated: number;
  invigilators: IdName[];
}

export interface ExamSlotView {
  id: string;
  period_id: string;
  subject: SubjectRef;
  grade_level: IdName;
  sections: IdName[];
  exam_date: string;
  starts_at: string;
  ends_at: string;
  assessment: IdName | null;
  notes: string | null;
  rooms: ExamSlotRoomView[];
  candidates: number;
  seated: number;
}

export interface ExamPeriodView extends ExamPeriodSummaryView {
  slots: ExamSlotView[];
}

export interface ExamPeriodInput {
  academic_year_id: string;
  term_id?: string | null | undefined;
  name: string;
  kind?: ExamPeriodKind | undefined;
  starts_on: string;
  ends_on: string;
  grade_level_ids: string[];
  status?: ExamPeriodStatus | undefined;
}

export interface ExamSlotInput {
  subject_id: string;
  grade_level_id: string;
  section_ids: string[];
  exam_date: string;
  starts_at: string;
  ends_at: string;
  assessment_id?: string | null | undefined;
  notes?: string | null | undefined;
  room_ids?: string[] | undefined;
}

interface SeatStudent {
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  section: IdName;
}

export interface ExamSeatView extends SeatStudent {
  room_id: string;
  seat_number: number;
}

export interface ExamSlotSeatingView {
  slot_id: string;
  seats: ExamSeatView[];
  unseated: SeatStudent[];
}

export interface ExamClashView {
  type: ExamClash["type"];
  severity: ExamClash["severity"];
  slot_ids: string[];
  room_ids: string[];
  teacher: IdName | null;
  students: IdName[];
  seat_number: number | null;
  seated: number | null;
  capacity: number | null;
  count: number | null;
  holiday: string | null;
}

export interface StudentExamTimetableView {
  student_id: string;
  timezone: string;
  periods: {
    id: string;
    name: string;
    kind: ExamPeriodKind;
    starts_on: string;
    ends_on: string;
    slots: {
      id: string;
      subject: SubjectRef;
      exam_date: string;
      starts_at: string;
      ends_at: string;
      room: RoomRef | null;
      seat_number: number | null;
    }[];
  }[];
}

export interface InvigilationDutyView {
  slot_id: string;
  period: IdName;
  subject: SubjectRef;
  grade_level: IdName;
  sections: IdName[];
  exam_date: string;
  starts_at: string;
  ends_at: string;
  room: RoomRef;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

function notFound(message: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, message);
}

function conflict(message: string): never {
  throw new CodedHttpException(409, ERROR_CODES.CONFLICT_STATE_MISMATCH, message);
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === code;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

const unique = (values: readonly string[]) => [...new Set(values)];

async function schoolTimezone(tx: TransactionSql, schoolId: string): Promise<string> {
  const [row] = await tx<{ timezone: string }[]>`
    SELECT timezone FROM app.school_settings WHERE school_id = ${schoolId}::uuid
  `;
  return row?.timezone ?? DEFAULT_TIMEZONE;
}

/** Every id is a row of `table` in the school, or 400 naming what is missing. */
async function requireIds(
  tx: TransactionSql,
  schoolId: string,
  table: "grade_levels" | "subjects" | "rooms" | "teachers",
  ids: readonly string[],
  label: string,
): Promise<void> {
  const wanted = unique(ids);
  if (wanted.length === 0) return;
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM ${tx("app")}.${tx(table)}
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${wanted}::uuid[])
  `;
  if (rows.length !== wanted.length) invalid(`Unknown ${label}`);
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

interface PeriodRow {
  id: string;
  academic_year_id: string;
  term_id: string | null;
  term_name: string | null;
  name: string;
  kind: ExamPeriodKind;
  starts_on: string;
  ends_on: string;
  status: ExamPeriodStatus;
  published_at: Date | null;
  slot_count: number;
  created_at: Date;
  updated_at: Date;
}

async function loadPeriods(
  tx: TransactionSql,
  schoolId: string,
  filter: { periodId?: string; academicYearId?: string },
): Promise<ExamPeriodSummaryView[]> {
  const periodClause = filter.periodId ? tx`AND period.id = ${filter.periodId}::uuid` : tx``;
  const yearClause = filter.academicYearId
    ? tx`AND period.academic_year_id = ${filter.academicYearId}::uuid`
    : tx``;
  const rows = await tx<PeriodRow[]>`
    SELECT period.id, period.academic_year_id, period.term_id, term.name AS term_name,
           period.name, period.kind, period.starts_on::text AS starts_on,
           period.ends_on::text AS ends_on, period.status, period.published_at,
           (SELECT count(*)::int FROM app.exam_period_slots AS slot
            WHERE slot.period_id = period.id AND slot.school_id = period.school_id) AS slot_count,
           period.created_at, period.updated_at
    FROM app.exam_periods AS period
    LEFT JOIN app.terms AS term ON term.id = period.term_id AND term.school_id = period.school_id
    WHERE period.school_id = ${schoolId}::uuid ${periodClause} ${yearClause}
    ORDER BY period.starts_on DESC, period.name, period.id
  `;
  if (rows.length === 0) return [];
  const grades = await tx<{ period_id: string; id: string; name: string }[]>`
    SELECT link.period_id, grade.id, grade.name
    FROM app.exam_period_grade_levels AS link
    JOIN app.grade_levels AS grade
      ON grade.id = link.grade_level_id AND grade.school_id = link.school_id
    WHERE link.school_id = ${schoolId}::uuid
      AND link.period_id = ANY (${rows.map((row) => row.id)}::uuid[])
    ORDER BY grade.sort_order, grade.name
  `;
  const gradesByPeriod = groupBy(grades, (row) => row.period_id);
  return rows.map((row) => ({
    id: row.id,
    academic_year_id: row.academic_year_id,
    term: row.term_id ? { id: row.term_id, name: row.term_name ?? "" } : null,
    name: row.name,
    kind: row.kind,
    starts_on: row.starts_on,
    ends_on: row.ends_on,
    status: row.status,
    published_at: iso(row.published_at),
    grade_levels: (gradesByPeriod.get(row.id) ?? []).map(({ id, name }) => ({ id, name })),
    slot_count: row.slot_count,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

async function requirePeriod(
  tx: TransactionSql,
  schoolId: string,
  periodId: string,
): Promise<ExamPeriodSummaryView> {
  const [period] = await loadPeriods(tx, schoolId, { periodId });
  if (!period) notFound("Exam period not found");
  return period;
}

export async function listExamPeriods(
  tx: TransactionSql,
  schoolId: string,
  academicYearId?: string,
): Promise<ExamPeriodSummaryView[]> {
  return loadPeriods(tx, schoolId, academicYearId ? { academicYearId } : {});
}

export async function getExamPeriod(
  tx: TransactionSql,
  schoolId: string,
  periodId: string,
): Promise<ExamPeriodView> {
  const period = await requirePeriod(tx, schoolId, periodId);
  const slots = await loadSlots(tx, schoolId, { periodId });
  return { ...period, slots: await slotViews(tx, schoolId, slots) };
}

async function checkPeriodInput(
  tx: TransactionSql,
  schoolId: string,
  input: ExamPeriodInput,
): Promise<void> {
  if (input.ends_on < input.starts_on) invalid("The period ends before it starts");
  const [year] = await tx<{ starts_on: string; ends_on: string }[]>`
    SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM app.academic_years
    WHERE id = ${input.academic_year_id}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!year) invalid("Unknown academic year");
  if (input.starts_on < year.starts_on || input.ends_on > year.ends_on) {
    invalid("The period's dates must fall within its academic year");
  }
  if (input.term_id) {
    const [term] = await tx<{ id: string }[]>`
      SELECT id FROM app.terms
      WHERE id = ${input.term_id}::uuid AND academic_year_id = ${input.academic_year_id}::uuid
        AND school_id = ${schoolId}::uuid
    `;
    if (!term) invalid("Unknown term for the academic year");
  }
  await requireIds(tx, schoolId, "grade_levels", input.grade_level_ids, "grade level");
}

function duplicatePeriodName(name: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
    `The academic year already has an exam period named "${name}"`,
  );
}

async function writePeriodGrades(
  tx: TransactionSql,
  schoolId: string,
  periodId: string,
  gradeLevelIds: readonly string[],
): Promise<void> {
  await tx`
    DELETE FROM app.exam_period_grade_levels
    WHERE school_id = ${schoolId}::uuid AND period_id = ${periodId}::uuid
  `;
  await tx`
    INSERT INTO app.exam_period_grade_levels (school_id, period_id, grade_level_id)
    SELECT ${schoolId}::uuid, ${periodId}::uuid, grade_id
    FROM unnest(${unique(gradeLevelIds)}::uuid[]) AS grade_id
  `;
}

const periodAudit = (period: ExamPeriodSummaryView | ExamPeriodInput) => ({
  name: period.name,
  kind: period.kind ?? "final",
  starts_on: period.starts_on,
  ends_on: period.ends_on,
  status: period.status ?? "draft",
  grade_level_ids:
    "grade_level_ids" in period
      ? unique(period.grade_level_ids)
      : period.grade_levels.map((grade) => grade.id),
});

export async function createExamPeriod(
  tx: TransactionSql,
  schoolId: string,
  input: ExamPeriodInput,
): Promise<ExamPeriodView> {
  await checkPeriodInput(tx, schoolId, input);
  const status = input.status ?? "draft";
  let periodId: string;
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.exam_periods (
          school_id, academic_year_id, term_id, name, kind, starts_on, ends_on, status, published_at
        )
        VALUES (
          ${schoolId}::uuid, ${input.academic_year_id}::uuid, ${input.term_id ?? null},
          ${input.name}, ${input.kind ?? "final"}, ${input.starts_on}::date, ${input.ends_on}::date,
          ${status}, ${status === "published" ? sp`CURRENT_TIMESTAMP` : null}
        )
        RETURNING id
      `,
    );
    periodId = row!.id;
  } catch (error) {
    if (isPgError(error, "23505")) duplicatePeriodName(input.name);
    throw error;
  }
  await writePeriodGrades(tx, schoolId, periodId, input.grade_level_ids);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "exam_periods",
    targetId: periodId,
    newValues: periodAudit(input),
  });
  return getExamPeriod(tx, schoolId, periodId);
}

export async function updateExamPeriod(
  tx: TransactionSql,
  schoolId: string,
  periodId: string,
  input: ExamPeriodInput,
): Promise<ExamPeriodView> {
  const before = await requirePeriod(tx, schoolId, periodId);
  if (input.academic_year_id !== before.academic_year_id) {
    invalid("An exam period cannot move to another academic year");
  }
  await checkPeriodInput(tx, schoolId, input);
  const [outside] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM app.exam_period_slots
    WHERE school_id = ${schoolId}::uuid AND period_id = ${periodId}::uuid
      AND (exam_date < ${input.starts_on}::date OR exam_date > ${input.ends_on}::date
           OR grade_level_id <> ALL (${unique(input.grade_level_ids)}::uuid[]))
  `;
  if ((outside?.count ?? 0) > 0) {
    conflict(
      `${outside!.count} exam(s) fall outside the new dates or grade levels; move or delete them first`,
    );
  }
  const status = input.status ?? before.status;
  try {
    await tx.savepoint(
      (sp) => sp`
        UPDATE app.exam_periods
        SET term_id = ${input.term_id ?? null}, name = ${input.name},
            kind = ${input.kind ?? before.kind}, starts_on = ${input.starts_on}::date,
            ends_on = ${input.ends_on}::date, status = ${status},
            published_at = ${
              status === "published"
                ? before.published_at
                  ? sp`published_at`
                  : sp`CURRENT_TIMESTAMP`
                : null
            },
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${periodId}::uuid AND school_id = ${schoolId}::uuid
      `,
    );
  } catch (error) {
    if (isPgError(error, "23505")) duplicatePeriodName(input.name);
    throw error;
  }
  await writePeriodGrades(tx, schoolId, periodId, input.grade_level_ids);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "exam_periods",
    targetId: periodId,
    oldValues: periodAudit(before),
    newValues: periodAudit({ ...input, kind: input.kind ?? before.kind, status }),
  });
  return getExamPeriod(tx, schoolId, periodId);
}

/** Delete a period with its timetable, seating and invigilators. */
export async function deleteExamPeriod(
  tx: TransactionSql,
  schoolId: string,
  periodId: string,
): Promise<void> {
  const before = await requirePeriod(tx, schoolId, periodId);
  await tx`
    DELETE FROM app.exam_periods WHERE id = ${periodId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "exam_periods",
    targetId: periodId,
    oldValues: { ...periodAudit(before), slot_count: before.slot_count },
  });
}

// ---------------------------------------------------------------------------
// Slots: loading
// ---------------------------------------------------------------------------

interface SlotRow {
  id: string;
  period_id: string;
  academic_year_id: string;
  grade_level_id: string;
  grade_level_name: string;
  subject_id: string;
  exam_date: string;
  starts_at: string;
  ends_at: string;
  assessment_id: string | null;
  assessment_name: string | null;
  notes: string | null;
}

interface LoadedSlot extends SlotRow {
  sections: IdName[];
  rooms: (RoomRef & { capacity: number | null; sort_order: number })[];
  invigilators: { room_id: string; teacher_id: string; name: string }[];
}

const SLOT_COLUMNS = `slot.id, slot.period_id, slot.academic_year_id, slot.grade_level_id,
  grade.name AS grade_level_name, slot.subject_id, slot.exam_date::text AS exam_date,
  to_char(slot.starts_at, 'HH24:MI') AS starts_at, to_char(slot.ends_at, 'HH24:MI') AS ends_at,
  slot.assessment_id, assessment.name AS assessment_name, slot.notes`;

async function loadSlots(
  tx: TransactionSql,
  schoolId: string,
  filter: { periodId?: string; slotIds?: readonly string[]; from?: string; to?: string },
): Promise<LoadedSlot[]> {
  const periodClause = filter.periodId ? tx`AND slot.period_id = ${filter.periodId}::uuid` : tx``;
  const idClause = filter.slotIds ? tx`AND slot.id = ANY (${[...filter.slotIds]}::uuid[])` : tx``;
  const dateClause =
    filter.from && filter.to
      ? tx`AND slot.exam_date BETWEEN ${filter.from}::date AND ${filter.to}::date`
      : tx``;
  const rows = await tx<SlotRow[]>`
    SELECT ${tx.unsafe(SLOT_COLUMNS)}
    FROM app.exam_period_slots AS slot
    JOIN app.grade_levels AS grade
      ON grade.id = slot.grade_level_id AND grade.school_id = slot.school_id
    LEFT JOIN app.subject_config_assessments AS assessment
      ON assessment.id = slot.assessment_id AND assessment.school_id = slot.school_id
    WHERE slot.school_id = ${schoolId}::uuid ${periodClause} ${idClause} ${dateClause}
    ORDER BY slot.exam_date, slot.starts_at, grade.sort_order, slot.id
  `;
  if (rows.length === 0) return [];
  const slotIds = rows.map((row) => row.id);
  const [sections, rooms, invigilators] = await Promise.all([
    tx<{ slot_id: string; id: string; name: string }[]>`
      SELECT link.slot_id, section.id, section.name
      FROM app.exam_period_slot_sections AS link
      JOIN app.sections AS section
        ON section.id = link.section_id AND section.school_id = link.school_id
      WHERE link.school_id = ${schoolId}::uuid AND link.slot_id = ANY (${slotIds}::uuid[])
      ORDER BY section.name, section.id
    `,
    tx<(RoomRef & { slot_id: string; capacity: number | null; sort_order: number })[]>`
      SELECT link.slot_id, room.id, room.code, room.name, room.building, room.floor,
             COALESCE(room.exam_capacity, room.capacity) AS capacity, link.sort_order
      FROM app.exam_period_slot_rooms AS link
      JOIN app.rooms AS room ON room.id = link.room_id AND room.school_id = link.school_id
      WHERE link.school_id = ${schoolId}::uuid AND link.slot_id = ANY (${slotIds}::uuid[])
      ORDER BY link.sort_order, room.code
    `,
    tx<{ slot_id: string; room_id: string; teacher_id: string; name: string }[]>`
      SELECT duty.slot_id, duty.room_id, duty.teacher_id,
             COALESCE(app_user.display_name, app_user.email, teacher.employee_number) AS name
      FROM app.exam_period_invigilators AS duty
      JOIN app.teachers AS teacher
        ON teacher.id = duty.teacher_id AND teacher.school_id = duty.school_id
      LEFT JOIN app.users AS app_user
        ON app_user.id = teacher.user_id AND app_user.school_id = teacher.school_id
      WHERE duty.school_id = ${schoolId}::uuid AND duty.slot_id = ANY (${slotIds}::uuid[])
      ORDER BY name, duty.teacher_id
    `,
  ]);
  const sectionsBySlot = groupBy(sections, (row) => row.slot_id);
  const roomsBySlot = groupBy(rooms, (row) => row.slot_id);
  const dutiesBySlot = groupBy(invigilators, (row) => row.slot_id);
  return rows.map((row) => ({
    ...row,
    sections: (sectionsBySlot.get(row.id) ?? []).map(({ id, name }) => ({ id, name })),
    rooms: (roomsBySlot.get(row.id) ?? []).map(({ slot_id: _slot, ...room }) => room),
    invigilators: (dutiesBySlot.get(row.id) ?? []).map(({ slot_id: _slot, ...duty }) => duty),
  }));
}

async function slotSubjects(
  tx: TransactionSql,
  slotIds: readonly string[],
): Promise<Map<string, SubjectRef>> {
  if (slotIds.length === 0) return new Map();
  const rows = await tx<{ slot_id: string; subject_id: string; code: string; name: string }[]>`
    SELECT slot_id, subject_id, code, name
    FROM app.exam_period_slot_subjects(${[...slotIds]}::uuid[])
  `;
  return new Map(
    rows.map((row) => [row.slot_id, { id: row.subject_id, code: row.code, name: row.name }]),
  );
}

interface Candidate {
  slot_id: string;
  student_id: string;
  first_name: string;
  last_name: string;
  admission_number: string;
  section_id: string;
  section_name: string;
}

/**
 * Who sits each slot (see the header): placed in one of its sections, not exempt, and enrolled
 * when the subject is optional or elective for the section. `studentId` narrows to one student.
 */
async function loadCandidates(
  tx: TransactionSql,
  schoolId: string,
  slotIds: readonly string[],
  studentId?: string,
): Promise<Map<string, Candidate[]>> {
  if (slotIds.length === 0) return new Map();
  const studentClause = studentId ? tx`AND placement.student_id = ${studentId}::uuid` : tx``;
  const rows = await tx<Candidate[]>`
    SELECT link.slot_id, student.id AS student_id, student.first_name, student.last_name,
           student.admission_number, section.id AS section_id, section.name AS section_name
    FROM app.exam_period_slot_sections AS link
    JOIN app.exam_period_slots AS slot ON slot.id = link.slot_id AND slot.school_id = link.school_id
    JOIN app.sections AS section
      ON section.id = link.section_id AND section.school_id = link.school_id
    JOIN app.student_sections AS placement
      ON placement.section_id = link.section_id
     AND placement.academic_year_id = link.academic_year_id
     AND placement.school_id = link.school_id
    JOIN app.students AS student
      ON student.id = placement.student_id AND student.school_id = placement.school_id
    LEFT JOIN LATERAL (
      SELECT config.requirement, config.is_excluded
      FROM app.subject_configs AS config
      WHERE config.school_id = slot.school_id
        AND config.academic_year_id = slot.academic_year_id
        AND config.grade_level_id = section.grade_level_id
        AND config.subject_id = slot.subject_id
        AND (config.section_id IS NULL OR config.section_id = section.id)
      ORDER BY config.section_id NULLS LAST
      LIMIT 1
    ) AS config ON true
    LEFT JOIN app.student_subject_enrollments AS choice
      ON choice.school_id = placement.school_id
     AND choice.academic_year_id = placement.academic_year_id
     AND choice.student_id = placement.student_id
     AND choice.subject_id = slot.subject_id
    WHERE link.school_id = ${schoolId}::uuid AND link.slot_id = ANY (${[...slotIds]}::uuid[])
      ${studentClause}
      AND NOT COALESCE(config.is_excluded, false)
      AND COALESCE(choice.status, 'none') <> 'exempt'
      AND (COALESCE(config.requirement, 'mandatory') = 'mandatory' OR choice.status = 'enrolled')
    ORDER BY student.last_name, student.first_name, student.id
  `;
  return groupBy(rows, (row) => row.slot_id);
}

interface SeatRow {
  slot_id: string;
  student_id: string;
  room_id: string;
  seat_number: number;
}

async function loadSeats(
  tx: TransactionSql,
  schoolId: string,
  slotIds: readonly string[],
): Promise<SeatRow[]> {
  if (slotIds.length === 0) return [];
  return tx<SeatRow[]>`
    SELECT slot_id, student_id, room_id, seat_number
    FROM app.exam_period_seats
    WHERE school_id = ${schoolId}::uuid AND slot_id = ANY (${[...slotIds]}::uuid[])
    ORDER BY slot_id, room_id, seat_number
  `;
}

async function slotViews(
  tx: TransactionSql,
  schoolId: string,
  slots: readonly LoadedSlot[],
): Promise<ExamSlotView[]> {
  const slotIds = slots.map((slot) => slot.id);
  const [subjects, candidates, seats] = await Promise.all([
    slotSubjects(tx, slotIds),
    loadCandidates(tx, schoolId, slotIds),
    loadSeats(tx, schoolId, slotIds),
  ]);
  const seatsBySlot = groupBy(seats, (seat) => seat.slot_id);
  return slots.map((slot) => {
    const slotSeats = seatsBySlot.get(slot.id) ?? [];
    return {
      id: slot.id,
      period_id: slot.period_id,
      subject: subjects.get(slot.id) ?? { id: slot.subject_id, code: "", name: "" },
      grade_level: { id: slot.grade_level_id, name: slot.grade_level_name },
      sections: slot.sections,
      exam_date: slot.exam_date,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      assessment: slot.assessment_id
        ? { id: slot.assessment_id, name: slot.assessment_name ?? "" }
        : null,
      notes: slot.notes,
      rooms: slot.rooms.map((room) => ({
        id: room.id,
        code: room.code,
        name: room.name,
        building: room.building,
        floor: room.floor,
        capacity: room.capacity,
        seated: slotSeats.filter((seat) => seat.room_id === room.id).length,
        invigilators: slot.invigilators
          .filter((duty) => duty.room_id === room.id)
          .map((duty) => ({ id: duty.teacher_id, name: duty.name })),
      })),
      candidates: (candidates.get(slot.id) ?? []).length,
      seated: slotSeats.length,
    };
  });
}

async function requireSlot(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
): Promise<LoadedSlot> {
  const [slot] = await loadSlots(tx, schoolId, { slotIds: [slotId] });
  if (!slot) notFound("Exam slot not found");
  return slot;
}

async function slotView(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
): Promise<ExamSlotView> {
  return (await slotViews(tx, schoolId, [await requireSlot(tx, schoolId, slotId)]))[0]!;
}

// ---------------------------------------------------------------------------
// Slots: writing
// ---------------------------------------------------------------------------

async function checkSlotInput(
  tx: TransactionSql,
  schoolId: string,
  period: ExamPeriodSummaryView,
  input: ExamSlotInput,
): Promise<void> {
  if (!period.grade_levels.some((grade) => grade.id === input.grade_level_id)) {
    invalid("The grade level is not one the exam period covers");
  }
  if (input.exam_date < period.starts_on || input.exam_date > period.ends_on) {
    invalid("The exam date must fall within the exam period");
  }
  if (input.ends_at <= input.starts_at) invalid("The exam must end after it starts");
  await requireIds(tx, schoolId, "subjects", [input.subject_id], "subject");

  const sectionIds = unique(input.section_ids);
  const sections = await tx<{ id: string }[]>`
    SELECT id FROM app.sections
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${sectionIds}::uuid[])
      AND academic_year_id = ${period.academic_year_id}::uuid
      AND grade_level_id = ${input.grade_level_id}::uuid
  `;
  if (sections.length !== sectionIds.length) {
    invalid("Every section must be one of the grade level's sections that academic year");
  }

  if (input.assessment_id) {
    const [assessment] = await tx<{ id: string }[]>`
      SELECT assessment.id
      FROM app.subject_config_assessments AS assessment
      JOIN app.subject_configs AS config
        ON config.id = assessment.subject_config_id AND config.school_id = assessment.school_id
      WHERE assessment.id = ${input.assessment_id}::uuid
        AND assessment.school_id = ${schoolId}::uuid
        AND assessment.academic_year_id = ${period.academic_year_id}::uuid
        AND config.subject_id = ${input.subject_id}::uuid
        AND config.grade_level_id = ${input.grade_level_id}::uuid
    `;
    if (!assessment) {
      invalid("The assessment must be one of the subject's assessments for the grade that year");
    }
  }

  const roomIds = input.room_ids ?? [];
  if (unique(roomIds).length !== roomIds.length) invalid("A room is listed twice");
  if (roomIds.length > 0) {
    const rooms = await tx<{ id: string }[]>`
      SELECT id FROM app.rooms
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${roomIds}::uuid[]) AND is_active
    `;
    if (rooms.length !== roomIds.length) invalid("Unknown or inactive room");
  }
}

/** Replace the slot's sections and rooms; seats of rooms taken off, or of students who no longer
 * sit the exam, go with them. */
async function writeSlotContents(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
  academicYearId: string,
  input: ExamSlotInput,
): Promise<void> {
  await tx`
    DELETE FROM app.exam_period_slot_sections
    WHERE school_id = ${schoolId}::uuid AND slot_id = ${slotId}::uuid
  `;
  await tx`
    INSERT INTO app.exam_period_slot_sections (school_id, slot_id, academic_year_id, section_id)
    SELECT ${schoolId}::uuid, ${slotId}::uuid, ${academicYearId}::uuid, section_id
    FROM unnest(${unique(input.section_ids)}::uuid[]) AS section_id
  `;
  if (input.room_ids !== undefined) {
    const roomIds = input.room_ids;
    await tx`
      DELETE FROM app.exam_period_slot_rooms
      WHERE school_id = ${schoolId}::uuid AND slot_id = ${slotId}::uuid
        AND room_id <> ALL (${roomIds}::uuid[])
    `;
    await tx`
      INSERT INTO app.exam_period_slot_rooms (school_id, slot_id, room_id, sort_order)
      SELECT ${schoolId}::uuid, ${slotId}::uuid, room_id, (ordinality - 1)::smallint
      FROM unnest(${roomIds}::uuid[]) WITH ORDINALITY AS room(room_id, ordinality)
      ON CONFLICT (school_id, slot_id, room_id) DO UPDATE SET sort_order = EXCLUDED.sort_order
    `;
  }
  const candidates = (await loadCandidates(tx, schoolId, [slotId])).get(slotId) ?? [];
  await tx`
    DELETE FROM app.exam_period_seats
    WHERE school_id = ${schoolId}::uuid AND slot_id = ${slotId}::uuid
      AND student_id <> ALL (${candidates.map((candidate) => candidate.student_id)}::uuid[])
  `;
}

const slotAudit = (slot: ExamSlotInput) => ({
  subject_id: slot.subject_id,
  grade_level_id: slot.grade_level_id,
  section_ids: unique(slot.section_ids),
  exam_date: slot.exam_date,
  starts_at: slot.starts_at,
  ends_at: slot.ends_at,
  assessment_id: slot.assessment_id ?? null,
  room_ids: slot.room_ids ?? null,
});

const loadedSlotAudit = (slot: LoadedSlot) => ({
  subject_id: slot.subject_id,
  grade_level_id: slot.grade_level_id,
  section_ids: slot.sections.map((section) => section.id),
  exam_date: slot.exam_date,
  starts_at: slot.starts_at,
  ends_at: slot.ends_at,
  assessment_id: slot.assessment_id,
  room_ids: slot.rooms.map((room) => room.id),
});

export async function createExamSlot(
  tx: TransactionSql,
  schoolId: string,
  periodId: string,
  input: ExamSlotInput,
): Promise<ExamSlotView> {
  const period = await requirePeriod(tx, schoolId, periodId);
  await checkSlotInput(tx, schoolId, period, input);
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.exam_period_slots (
      school_id, academic_year_id, period_id, grade_level_id, subject_id, exam_date, starts_at,
      ends_at, assessment_id, notes
    )
    VALUES (
      ${schoolId}::uuid, ${period.academic_year_id}::uuid, ${periodId}::uuid,
      ${input.grade_level_id}::uuid, ${input.subject_id}::uuid, ${input.exam_date}::date,
      ${input.starts_at}::time, ${input.ends_at}::time, ${input.assessment_id ?? null},
      ${input.notes || null}
    )
    RETURNING id
  `;
  await writeSlotContents(tx, schoolId, row!.id, period.academic_year_id, {
    ...input,
    room_ids: input.room_ids ?? [],
  });
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "exam_period_slots",
    targetId: row!.id,
    newValues: { period_id: periodId, ...slotAudit(input) },
  });
  return slotView(tx, schoolId, row!.id);
}

export async function updateExamSlot(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
  input: ExamSlotInput,
): Promise<ExamSlotView> {
  const before = await requireSlot(tx, schoolId, slotId);
  const period = await requirePeriod(tx, schoolId, before.period_id);
  await checkSlotInput(tx, schoolId, period, input);
  await tx`
    UPDATE app.exam_period_slots
    SET grade_level_id = ${input.grade_level_id}::uuid, subject_id = ${input.subject_id}::uuid,
        exam_date = ${input.exam_date}::date, starts_at = ${input.starts_at}::time,
        ends_at = ${input.ends_at}::time, assessment_id = ${input.assessment_id ?? null},
        notes = ${input.notes || null}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${slotId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await writeSlotContents(tx, schoolId, slotId, period.academic_year_id, input);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "exam_period_slots",
    targetId: slotId,
    oldValues: loadedSlotAudit(before),
    newValues: slotAudit(input),
  });
  return slotView(tx, schoolId, slotId);
}

export async function deleteExamSlot(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
): Promise<void> {
  const before = await requireSlot(tx, schoolId, slotId);
  await tx`
    DELETE FROM app.exam_period_slots WHERE id = ${slotId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "exam_period_slots",
    targetId: slotId,
    oldValues: { period_id: before.period_id, ...loadedSlotAudit(before) },
  });
}

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------

/** Seat numbers other slots use in these rooms at the same time as the slot. */
async function takenSeats(
  tx: TransactionSql,
  schoolId: string,
  slot: LoadedSlot,
): Promise<Map<string, Set<number>>> {
  const roomIds = slot.rooms.map((room) => room.id);
  const out = new Map<string, Set<number>>(roomIds.map((id) => [id, new Set<number>()]));
  if (roomIds.length === 0) return out;
  const rows = await tx<{ room_id: string; seat_number: number }[]>`
    SELECT seat.room_id, seat.seat_number
    FROM app.exam_period_seats AS seat
    JOIN app.exam_period_slots AS other
      ON other.id = seat.slot_id AND other.school_id = seat.school_id
    WHERE seat.school_id = ${schoolId}::uuid
      AND seat.room_id = ANY (${roomIds}::uuid[])
      AND other.id <> ${slot.id}::uuid
      AND other.exam_date = ${slot.exam_date}::date
      AND other.starts_at < ${slot.ends_at}::time
      AND other.ends_at > ${slot.starts_at}::time
  `;
  for (const row of rows) out.get(row.room_id)?.add(row.seat_number);
  return out;
}

function seatingRooms(slot: LoadedSlot, taken: Map<string, Set<number>>): SeatingRoom[] {
  return slot.rooms.map((room) => ({
    room_id: room.id,
    capacity: room.capacity,
    taken: taken.get(room.id) ?? [],
  }));
}

function seatingView(
  slotId: string,
  candidates: readonly Candidate[],
  seats: readonly Seat[],
  roomOrder: readonly string[],
): ExamSlotSeatingView {
  const byStudent = new Map(candidates.map((candidate) => [candidate.student_id, candidate]));
  const student = (candidate: Candidate): SeatStudent => ({
    student_id: candidate.student_id,
    first_name: candidate.first_name,
    last_name: candidate.last_name,
    admission_number: candidate.admission_number,
    section: { id: candidate.section_id, name: candidate.section_name },
  });
  const order = new Map(roomOrder.map((id, index) => [id, index]));
  const seated = new Set<string>();
  const views: ExamSeatView[] = [];
  for (const seat of [...seats].sort(
    (a, b) =>
      (order.get(a.room_id) ?? 0) - (order.get(b.room_id) ?? 0) || a.seat_number - b.seat_number,
  )) {
    const candidate = byStudent.get(seat.student_id);
    if (!candidate) continue;
    seated.add(seat.student_id);
    views.push({ ...student(candidate), room_id: seat.room_id, seat_number: seat.seat_number });
  }
  return {
    slot_id: slotId,
    seats: views,
    unseated: candidates.filter((c) => !seated.has(c.student_id)).map(student),
  };
}

/** Every slot's seating in a period: the seating lists and door sheets print from this. */
export async function getExamPeriodSeating(
  tx: TransactionSql,
  schoolId: string,
  periodId: string,
): Promise<{ period_id: string; slots: ExamSlotSeatingView[] }> {
  await requirePeriod(tx, schoolId, periodId);
  const slots = await loadSlots(tx, schoolId, { periodId });
  const slotIds = slots.map((slot) => slot.id);
  const [candidates, seats] = await Promise.all([
    loadCandidates(tx, schoolId, slotIds),
    loadSeats(tx, schoolId, slotIds),
  ]);
  const seatsBySlot = groupBy(seats, (seat) => seat.slot_id);
  return {
    period_id: periodId,
    slots: slots.map((slot) =>
      seatingView(
        slot.id,
        candidates.get(slot.id) ?? [],
        seatsBySlot.get(slot.id) ?? [],
        slot.rooms.map((room) => room.id),
      ),
    ),
  };
}

async function writeSeats(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
  seats: readonly Seat[],
): Promise<void> {
  if (seats.length === 0) return;
  await tx`
    INSERT INTO app.exam_period_seats (school_id, slot_id, room_id, student_id, seat_number)
    SELECT ${schoolId}::uuid, ${slotId}::uuid, seat.room_id, seat.student_id, seat.seat_number
    FROM unnest(
      ${seats.map((seat) => seat.room_id)}::uuid[],
      ${seats.map((seat) => seat.student_id)}::uuid[],
      ${seats.map((seat) => seat.seat_number)}::int[]
    ) AS seat(room_id, student_id, seat_number)
  `;
}

/** Generate a slot's seating (the pure seating.ts), keeping still-valid seats unless told not to. */
export async function generateExamSeating(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
  input: { strategy: SeatingStrategy; keep_existing?: boolean | undefined },
): Promise<ExamSlotSeatingView & { kept: number }> {
  const slot = await requireSlot(tx, schoolId, slotId);
  if (slot.rooms.length === 0) invalid("Add the exam's rooms before seating it");
  const candidates = (await loadCandidates(tx, schoolId, [slotId])).get(slotId) ?? [];
  const existing = await loadSeats(tx, schoolId, [slotId]);
  const taken = await takenSeats(tx, schoolId, slot);
  const result = generateSeating({
    candidates: candidates.map((candidate) => ({
      student_id: candidate.student_id,
      section_id: candidate.section_id,
      section_name: candidate.section_name,
      first_name: candidate.first_name,
      last_name: candidate.last_name,
    })),
    rooms: seatingRooms(slot, taken),
    strategy: input.strategy,
    existing,
    keepExisting: input.keep_existing ?? true,
  });
  await tx`
    DELETE FROM app.exam_period_seats
    WHERE school_id = ${schoolId}::uuid AND slot_id = ${slotId}::uuid
  `;
  await writeSeats(tx, schoolId, slotId, result.seats);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "exam_period_seats",
    targetId: slotId,
    oldValues: { seated: existing.length },
    newValues: {
      strategy: input.strategy,
      keep_existing: input.keep_existing ?? true,
      seated: result.seats.length,
      kept: result.kept,
      unseated: result.unseated.length,
    },
  });
  return {
    ...seatingView(
      slotId,
      candidates,
      result.seats,
      slot.rooms.map((room) => room.id),
    ),
    kept: result.kept,
  };
}

/** Move one student to another seat of the slot, swapping with whoever of the slot sits there. */
export async function moveExamSeat(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
  studentId: string,
  input: { room_id: string; seat_number: number },
): Promise<ExamSlotSeatingView> {
  const slot = await requireSlot(tx, schoolId, slotId);
  const seats = await loadSeats(tx, schoolId, [slotId]);
  const plan = planSeatMove({
    student_id: studentId,
    room_id: input.room_id,
    seat_number: input.seat_number,
    rooms: seatingRooms(slot, await takenSeats(tx, schoolId, slot)),
    seats,
  });
  if (plan.kind === "rejected") {
    if (plan.reason === "NOT_SEATED_HERE") notFound("The student has no seat in this exam");
    if (plan.reason === "ROOM_NOT_IN_SLOT") invalid("The room is not one of the exam's rooms");
    if (plan.reason === "SEAT_OUT_OF_RANGE")
      invalid("The seat number is beyond the room's capacity");
    conflict("Another exam in the room at the same time uses that seat");
  }
  const moved: Seat[] = [{ student_id: studentId, ...input }];
  const studentIds = [studentId];
  if (plan.kind === "swap") {
    moved.push({ ...plan.from, student_id: plan.with_student_id });
    studentIds.push(plan.with_student_id);
  }
  await tx`
    DELETE FROM app.exam_period_seats
    WHERE school_id = ${schoolId}::uuid AND slot_id = ${slotId}::uuid
      AND student_id = ANY (${studentIds}::uuid[])
  `;
  await writeSeats(tx, schoolId, slotId, moved);
  const from = seats.find((seat) => seat.student_id === studentId)!;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "exam_period_seats",
    targetId: slotId,
    oldValues: { student_id: studentId, room_id: from.room_id, seat_number: from.seat_number },
    newValues: {
      student_id: studentId,
      ...input,
      swapped_with_student_id: plan.kind === "swap" ? plan.with_student_id : null,
    },
  });
  const candidates = (await loadCandidates(tx, schoolId, [slotId])).get(slotId) ?? [];
  return seatingView(
    slotId,
    candidates,
    await loadSeats(tx, schoolId, [slotId]),
    slot.rooms.map((room) => room.id),
  );
}

// ---------------------------------------------------------------------------
// Invigilators
// ---------------------------------------------------------------------------

export async function setExamInvigilators(
  tx: TransactionSql,
  schoolId: string,
  slotId: string,
  input: { rooms: { room_id: string; teacher_ids: string[] }[] },
): Promise<ExamSlotView> {
  const slot = await requireSlot(tx, schoolId, slotId);
  const slotRooms = new Set(slot.rooms.map((room) => room.id));
  const pairs: { room_id: string; teacher_id: string }[] = [];
  for (const room of input.rooms) {
    if (!slotRooms.has(room.room_id)) invalid("The room is not one of the exam's rooms");
    for (const teacherId of unique(room.teacher_ids)) {
      pairs.push({ room_id: room.room_id, teacher_id: teacherId });
    }
  }
  await requireIds(
    tx,
    schoolId,
    "teachers",
    pairs.map((pair) => pair.teacher_id),
    "teacher",
  );
  const pairKeys = unique(pairs.map((pair) => `${pair.room_id}|${pair.teacher_id}`));
  if (pairKeys.length !== pairs.length) invalid("A room is listed twice");
  await tx`
    DELETE FROM app.exam_period_invigilators
    WHERE school_id = ${schoolId}::uuid AND slot_id = ${slotId}::uuid
  `;
  if (pairs.length > 0) {
    await tx`
      INSERT INTO app.exam_period_invigilators (school_id, slot_id, room_id, teacher_id)
      SELECT ${schoolId}::uuid, ${slotId}::uuid, duty.room_id, duty.teacher_id
      FROM unnest(
        ${pairs.map((pair) => pair.room_id)}::uuid[],
        ${pairs.map((pair) => pair.teacher_id)}::uuid[]
      ) AS duty(room_id, teacher_id)
    `;
  }
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "exam_period_invigilators",
    targetId: slotId,
    oldValues: {
      invigilators: slot.invigilators.map(({ room_id, teacher_id }) => ({ room_id, teacher_id })),
    },
    newValues: { invigilators: pairs },
  });
  return slotView(tx, schoolId, slotId);
}

// ---------------------------------------------------------------------------
// Clashes
// ---------------------------------------------------------------------------

/**
 * Every clash involving a period's exams. Exams of other periods on the same days count too (a
 * teacher booked in two periods that share a week), but only clashes touching this period are
 * returned.
 */
export async function getExamPeriodClashes(
  tx: TransactionSql,
  schoolId: string,
  periodId: string,
): Promise<{ period_id: string; clashes: ExamClashView[] }> {
  const period = await requirePeriod(tx, schoolId, periodId);
  const slots = await loadSlots(tx, schoolId, { from: period.starts_on, to: period.ends_on });
  const slotIds = slots.map((slot) => slot.id);
  const [candidates, seats, holidays] = await Promise.all([
    loadCandidates(tx, schoolId, slotIds),
    loadSeats(tx, schoolId, slotIds),
    tx<{ title: string; starts_on: string; ends_on: string }[]>`
      SELECT title, starts_on::text AS starts_on, ends_on::text AS ends_on
      FROM app.school_events
      WHERE school_id = ${schoolId}::uuid AND kind = 'holiday'
        AND starts_on <= ${period.ends_on}::date AND ends_on >= ${period.starts_on}::date
      ORDER BY starts_on, title
    `,
  ]);
  const seatsBySlot = groupBy(seats, (seat) => seat.slot_id);
  const input: ClashSlot[] = slots.map((slot) => ({
    slot_id: slot.id,
    exam_date: slot.exam_date,
    starts_at: slot.starts_at,
    ends_at: slot.ends_at,
    student_ids: (candidates.get(slot.id) ?? []).map((candidate) => candidate.student_id),
    rooms: slot.rooms.map((room) => ({ room_id: room.id, capacity: room.capacity })),
    seats: seatsBySlot.get(slot.id) ?? [],
    invigilators: slot.invigilators.map(({ room_id, teacher_id }) => ({ room_id, teacher_id })),
  }));
  const own = new Set(slots.filter((slot) => slot.period_id === periodId).map((slot) => slot.id));
  const clashes = detectExamClashes(input, holidays).filter((clash) =>
    clash.slot_ids.some((id) => own.has(id)),
  );

  const teacherNames = new Map(
    slots.flatMap((slot) => slot.invigilators.map((duty) => [duty.teacher_id, duty.name] as const)),
  );
  const studentNames = new Map(
    [...candidates.values()]
      .flat()
      .map((c) => [c.student_id, `${c.first_name} ${c.last_name}`] as const),
  );
  return {
    period_id: periodId,
    clashes: clashes.map((clash) => {
      const view: ExamClashView = {
        type: clash.type,
        severity: clash.severity,
        slot_ids: clash.slot_ids,
        room_ids: [],
        teacher: null,
        students: [],
        seat_number: null,
        seated: null,
        capacity: null,
        count: null,
        holiday: null,
      };
      switch (clash.type) {
        case "teacher_double_booked":
          view.room_ids = clash.room_ids;
          view.teacher = { id: clash.teacher_id, name: teacherNames.get(clash.teacher_id) ?? "" };
          break;
        case "student_double_booked":
          view.students = clash.student_ids.map((id) => ({ id, name: studentNames.get(id) ?? "" }));
          view.count = clash.student_ids.length;
          break;
        case "room_over_capacity":
          view.room_ids = [clash.room_id];
          view.seated = clash.seated;
          view.capacity = clash.capacity;
          break;
        case "seat_double_booked":
          view.room_ids = [clash.room_id];
          view.seat_number = clash.seat_number;
          break;
        case "room_without_capacity":
        case "no_invigilator":
          view.room_ids = [clash.room_id];
          break;
        case "insufficient_capacity":
          view.count = clash.candidates;
          view.capacity = clash.capacity;
          break;
        case "unseated_students":
          view.count = clash.count;
          break;
        case "on_holiday":
          view.holiday = clash.holiday;
          break;
      }
      return view;
    }),
  };
}

// ---------------------------------------------------------------------------
// The apps
// ---------------------------------------------------------------------------

/**
 * A student's exam timetable: every published period's exams the student sits, with their room
 * and seat once seated. Read by whoever may read the student (app.can_read_student).
 */
export async function studentExamTimetable(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<StudentExamTimetableView> {
  await assertCanReadStudent(tx, studentId);
  // Leadership of another school passes the role check; the student is not in their school.
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student) notFound("Student not found");

  const slotRows = await tx<{ id: string }[]>`
    SELECT DISTINCT slot.id
    FROM app.exam_period_slots AS slot
    JOIN app.exam_periods AS period
      ON period.id = slot.period_id AND period.school_id = slot.school_id
    JOIN app.exam_period_slot_sections AS link
      ON link.slot_id = slot.id AND link.school_id = slot.school_id
    JOIN app.student_sections AS placement
      ON placement.section_id = link.section_id
     AND placement.academic_year_id = link.academic_year_id
     AND placement.school_id = link.school_id
    WHERE slot.school_id = ${schoolId}::uuid AND period.status = 'published'
      AND placement.student_id = ${studentId}::uuid
  `;
  const candidates = await loadCandidates(
    tx,
    schoolId,
    slotRows.map((row) => row.id),
    studentId,
  );
  const slotIds = [...candidates.keys()];
  const timezone = await schoolTimezone(tx, schoolId);
  if (slotIds.length === 0) return { student_id: studentId, timezone, periods: [] };

  const [slots, subjects, seats] = await Promise.all([
    loadSlots(tx, schoolId, { slotIds }),
    slotSubjects(tx, slotIds),
    tx<{ slot_id: string; room_id: string; seat_number: number }[]>`
      SELECT slot_id, room_id, seat_number FROM app.exam_period_seats
      WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
        AND slot_id = ANY (${slotIds}::uuid[])
    `,
  ]);
  const periodIds = unique(slots.map((slot) => slot.period_id));
  const periods = await tx<
    { id: string; name: string; kind: ExamPeriodKind; starts_on: string; ends_on: string }[]
  >`
    SELECT id, name, kind, starts_on::text AS starts_on, ends_on::text AS ends_on
    FROM app.exam_periods
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${periodIds}::uuid[])
    ORDER BY starts_on, name, id
  `;
  const seatBySlot = new Map(seats.map((seat) => [seat.slot_id, seat]));
  const slotsByPeriod = groupBy(slots, (slot) => slot.period_id);
  return {
    student_id: studentId,
    timezone,
    periods: periods.map((period) => ({
      ...period,
      slots: (slotsByPeriod.get(period.id) ?? []).map((slot) => {
        const seat = seatBySlot.get(slot.id);
        const room = seat ? slot.rooms.find((candidate) => candidate.id === seat.room_id) : null;
        return {
          id: slot.id,
          subject: subjects.get(slot.id) ?? { id: slot.subject_id, code: "", name: "" },
          exam_date: slot.exam_date,
          starts_at: slot.starts_at,
          ends_at: slot.ends_at,
          room: room
            ? {
                id: room.id,
                code: room.code,
                name: room.name,
                building: room.building,
                floor: room.floor,
              }
            : null,
          seat_number: seat && room ? seat.seat_number : null,
        };
      }),
    })),
  };
}

/** The signed-in teacher's invigilation duties in published periods; none for anyone else. */
export async function myInvigilationDuties(
  tx: TransactionSql,
  schoolId: string,
): Promise<{ timezone: string; duties: InvigilationDutyView[] }> {
  const timezone = await schoolTimezone(tx, schoolId);
  const [me] = await tx<{ teacher_id: string | null }[]>`
    SELECT app.current_user_teacher_id() AS teacher_id
  `;
  if (!me?.teacher_id) return { timezone, duties: [] };
  const rows = await tx<
    { slot_id: string; room_id: string; period_id: string; period_name: string }[]
  >`
    SELECT duty.slot_id, duty.room_id, period.id AS period_id, period.name AS period_name
    FROM app.exam_period_invigilators AS duty
    JOIN app.exam_period_slots AS slot ON slot.id = duty.slot_id AND slot.school_id = duty.school_id
    JOIN app.exam_periods AS period
      ON period.id = slot.period_id AND period.school_id = slot.school_id
    WHERE duty.school_id = ${schoolId}::uuid AND duty.teacher_id = ${me.teacher_id}::uuid
      AND period.status = 'published'
  `;
  if (rows.length === 0) return { timezone, duties: [] };
  const slotIds = unique(rows.map((row) => row.slot_id));
  const [slots, subjects] = await Promise.all([
    loadSlots(tx, schoolId, { slotIds }),
    slotSubjects(tx, slotIds),
  ]);
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  const duties: InvigilationDutyView[] = [];
  for (const row of rows) {
    const slot = slotById.get(row.slot_id);
    const room = slot?.rooms.find((candidate) => candidate.id === row.room_id);
    if (!slot || !room) continue;
    duties.push({
      slot_id: slot.id,
      period: { id: row.period_id, name: row.period_name },
      subject: subjects.get(slot.id) ?? { id: slot.subject_id, code: "", name: "" },
      grade_level: { id: slot.grade_level_id, name: slot.grade_level_name },
      sections: slot.sections,
      exam_date: slot.exam_date,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      room: {
        id: room.id,
        code: room.code,
        name: room.name,
        building: room.building,
        floor: room.floor,
      },
    });
  }
  duties.sort(
    (a, b) =>
      a.exam_date.localeCompare(b.exam_date) ||
      a.starts_at.localeCompare(b.starts_at) ||
      a.room.code.localeCompare(b.room.code),
  );
  return { timezone, duties };
}
