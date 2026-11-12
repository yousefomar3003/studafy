import { createHash, randomBytes } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
import { calculateCumulativeResult } from "@studafy/grading-engine";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { blockingReasons } from "./certificate-service";
import { readFinalizationResults } from "./results-service";

import type { StoredStudentResult } from "./results-service";
import type { CumulativeResult, ResultDisplay, RoundingRule } from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Academic transcripts (000207): every year of a student's finalized annual results on one
 * document, with a cumulative average and GPA — for example, for a university application.
 *
 * A transcript is issued like a certificate: rendered once from the stored result rows, kept whole
 * in `content` with its SHA-256, and never edited. Showing or printing one reads that content and
 * nothing else. It covers, per academic year, the student's current (not superseded) annual
 * finalization; when a student has two in one year (they changed section), the later one is the
 * year's result. It is issued only when every covered year is complete — no invented marks.
 *
 * Later changes never reach an issued transcript. A correction of a covered year, or a newly
 * finalized year, is reported as `needs_reissue` with the reason; a reissue writes a new document
 * and marks the old one superseded.
 */

export type TranscriptStaleReason = "corrected" | "new_results";

export interface TranscriptSubject {
  code: string;
  name: string;
  requirement: string;
  marks_obtained: number | null;
  max_marks: number;
  percentage: number | null;
  grade_label: string | null;
  gpa_points: number | null;
  passed: boolean | null;
  exempt: boolean;
  include_in_average: boolean;
  average_weight: number;
}

export interface TranscriptYear {
  academic_year: { id: string; code: string; name: string };
  grade_level_name: string;
  section_name: string;
  finalization: { id: string; version: number; finalized_at: string };
  subjects: TranscriptSubject[];
  overall: {
    average_percentage: number | null;
    total_obtained: number | null;
    total_max: number | null;
    grade_label: string | null;
    subjects_failed: number;
    academic_status: string;
    /** The year's result in its grade's format (out of 20, GPA...); null on a percentage-only row. */
    display: ResultDisplay | null;
  };
}

export interface TranscriptCumulative {
  average_percentage: number | null;
  gpa: number | null;
  gpa_unavailable_reason: CumulativeResult["gpaUnavailableReason"];
  subjects_without_gpa_points: string[];
  years_covered: number;
  subjects_counted: number;
}

export interface TranscriptContent {
  version: 1;
  kind: "transcript";
  serial_number: string;
  issued_at: string;
  school: { id: string; name: string };
  student: { id: string; first_name: string; last_name: string; admission_number: string };
  years: TranscriptYear[];
  cumulative: TranscriptCumulative;
  issued_by: { user_id: string; name: string | null };
  reissue: { supersedes_serial: string; reason: string } | null;
}

export interface TranscriptView {
  id: string;
  serial_number: string;
  status: "issued" | "superseded" | "revoked";
  student_id: string;
  issued_at: string;
  supersedes_id: string | null;
  reissue_reason: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  content_sha256: string;
  needs_reissue: boolean;
  stale_reasons: TranscriptStaleReason[];
  content: TranscriptContent;
}

export type TranscriptState = "ready" | "issued" | "needs_reissue" | "blocked";

export interface TranscriptReadiness {
  state: TranscriptState;
  reasons: string[];
  current_transcript_id: string | null;
  years: {
    academic_year_id: string;
    academic_year_name: string;
    grade_level_name: string;
    section_name: string;
    status: "complete" | "incomplete";
  }[];
  cumulative: TranscriptCumulative | null;
}

const DEFAULT_ROUNDING: RoundingRule = { decimals: 2, mode: "half_up" };

// ---------------------------------------------------------------------------
// Reading the covered years
// ---------------------------------------------------------------------------

interface CoveredFinalization {
  id: string;
  academic_year_id: string;
  year_code: string;
  year_name: string;
  section_name: string;
  grade_level_name: string;
  version: number;
  finalized_at: Date;
  starts_on: Date;
}

interface CoveredYear {
  finalization: CoveredFinalization;
  result: StoredStudentResult;
  /** subject_id -> average weight, from the snapshot the result was computed with. */
  weights: Map<string, number>;
  rounding: RoundingRule;
}

/**
 * The student's current annual finalization in each academic year, oldest year first. Two in one
 * year (a change of section) keep the later; the earlier section's result is not the year's.
 */
async function currentAnnualFinalizations(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<CoveredFinalization[]> {
  return tx<CoveredFinalization[]>`
    SELECT DISTINCT ON (finalization.academic_year_id)
           finalization.id, finalization.academic_year_id, year.code AS year_code,
           year.name AS year_name, section.name AS section_name, grade.name AS grade_level_name,
           finalization.version, finalization.finalized_at, year.starts_on
    FROM app.student_overall_results AS overall
    JOIN app.result_finalizations AS finalization
      ON finalization.id = overall.finalization_id AND finalization.school_id = overall.school_id
    JOIN app.academic_years AS year
      ON year.id = finalization.academic_year_id AND year.school_id = finalization.school_id
    JOIN app.sections AS section
      ON section.id = finalization.section_id AND section.school_id = finalization.school_id
    JOIN app.grade_levels AS grade
      ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    WHERE overall.school_id = ${schoolId}::uuid AND overall.student_id = ${studentId}::uuid
      AND finalization.term_id IS NULL AND finalization.status = 'finalized'
    ORDER BY finalization.academic_year_id, finalization.finalized_at DESC, finalization.id
  `.then((rows) => [...rows].sort((a, b) => a.starts_on.getTime() - b.starts_on.getTime()));
}

async function loadCoveredYears(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<CoveredYear[]> {
  const finalizations = await currentAnnualFinalizations(tx, schoolId, studentId);
  if (finalizations.length === 0) return [];
  const snapshots = await tx<
    {
      finalization_id: string;
      subject_id: string;
      average_weight: string | null;
      rounding: RoundingRule | null;
    }[]
  >`
    SELECT result.finalization_id, result.subject_id,
           result.config_snapshot->>'average_weight' AS average_weight,
           result.config_snapshot->'program'->'rounding' AS rounding
    FROM app.student_subject_results AS result
    WHERE result.school_id = ${schoolId}::uuid AND result.student_id = ${studentId}::uuid
      AND result.finalization_id = ANY (${finalizations.map((f) => f.id)}::uuid[])
  `;
  const years: CoveredYear[] = [];
  for (const finalization of finalizations) {
    const [result] = await readFinalizationResults(tx, schoolId, finalization.id, { studentId });
    if (!result) continue;
    const rows = snapshots.filter((row) => row.finalization_id === finalization.id);
    const weights = new Map<string, number>();
    for (const row of rows) {
      const weight = Number(row.average_weight);
      weights.set(row.subject_id, Number.isFinite(weight) && weight > 0 ? weight : 1);
    }
    const rounding = rows.find((row) => row.rounding !== null)?.rounding ?? DEFAULT_ROUNDING;
    years.push({ finalization, result, weights, rounding });
  }
  return years;
}

function yearReasons(year: CoveredYear): string[] {
  return blockingReasons(year.result).map((reason) => `${year.finalization.year_name}: ${reason}`);
}

function cumulativeOf(years: readonly CoveredYear[]): TranscriptCumulative {
  // The latest year's rounding rule: the school's current convention for showing an average.
  const rounding = years.at(-1)?.rounding ?? DEFAULT_ROUNDING;
  const result = calculateCumulativeResult(
    years.map((year) => ({
      subjects: year.result.subjects.map((subject) => ({
        label: `${subject.subject_name} (${year.finalization.year_name})`,
        status: subject.status,
        includeInAverage: subject.include_in_average,
        averageWeight: year.weights.get(subject.subject_id) ?? 1,
        percentage: subject.percentage,
        gpaPoints: subject.gpa_points,
      })),
    })),
    rounding,
  );
  return {
    average_percentage: result.averagePercentage,
    gpa: result.gpa,
    gpa_unavailable_reason: result.gpaUnavailableReason,
    subjects_without_gpa_points: result.subjectsWithoutGpaPoints,
    years_covered: years.length,
    subjects_counted: result.subjectsCounted,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Readable, unambiguous serial: TR and 10 random Crockford base32 characters. */
function newSerial(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let suffix = "";
  for (const byte of randomBytes(10)) suffix += alphabet.charAt(byte % 32);
  return `TR-${suffix}`;
}

function renderYear(year: CoveredYear): TranscriptYear {
  const { finalization, result } = year;
  return {
    academic_year: {
      id: finalization.academic_year_id,
      code: finalization.year_code,
      name: finalization.year_name,
    },
    grade_level_name: finalization.grade_level_name,
    section_name: finalization.section_name,
    finalization: {
      id: finalization.id,
      version: finalization.version,
      finalized_at: finalization.finalized_at.toISOString(),
    },
    subjects: result.subjects
      .filter((subject) => subject.include_on_certificate)
      .map((subject) => ({
        code: subject.subject_code,
        name: subject.subject_name,
        requirement: subject.requirement,
        marks_obtained: subject.marks_obtained,
        max_marks: subject.max_marks,
        percentage: subject.percentage,
        grade_label: subject.grade_label,
        gpa_points: subject.gpa_points,
        passed: subject.passed,
        exempt: subject.status === "exempt",
        include_in_average: subject.include_in_average,
        average_weight: year.weights.get(subject.subject_id) ?? 1,
      })),
    overall: {
      average_percentage: result.average_percentage,
      total_obtained: result.total_obtained,
      total_max: result.total_max,
      grade_label: result.grade_label,
      subjects_failed: result.subjects_failed,
      academic_status: result.academic_status,
      display: result.result_display,
    },
  };
}

async function renderContent(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  years: readonly CoveredYear[],
  serial: string,
  reissue: TranscriptContent["reissue"],
): Promise<TranscriptContent> {
  const [names] = await tx<{ school_name: string; issuer_name: string | null }[]>`
    SELECT school.name AS school_name,
           (SELECT display_name FROM app.users
            WHERE id = ${userId}::uuid AND school_id = ${schoolId}::uuid) AS issuer_name
    FROM app.schools AS school WHERE school.id = ${schoolId}::uuid
  `;
  const student = years[0]!.result;
  return {
    version: 1,
    kind: "transcript",
    serial_number: serial,
    issued_at: new Date().toISOString(),
    school: { id: schoolId, name: names?.school_name ?? "" },
    student: {
      id: student.student_id,
      first_name: student.first_name,
      last_name: student.last_name,
      admission_number: student.admission_number,
    },
    years: years.map(renderYear),
    cumulative: cumulativeOf(years),
    issued_by: { user_id: userId, name: names?.issuer_name ?? null },
    reissue,
  };
}

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

interface TranscriptRow {
  id: string;
  serial_number: string;
  status: TranscriptView["status"];
  student_id: string;
  issued_at: Date;
  supersedes_id: string | null;
  reissue_reason: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  content_sha256: string;
  content: TranscriptContent;
  corrected: boolean;
  new_results: boolean;
}

/**
 * `corrected`: a covered finalization has been superseded. `new_results`: the student has a current
 * annual finalization in a year the transcript does not cover (a newer year was finalized).
 */
const TRANSCRIPT_COLUMNS = `
  transcript.id, transcript.serial_number, transcript.status, transcript.student_id,
  transcript.issued_at, transcript.supersedes_id, transcript.reissue_reason, transcript.revoked_at,
  transcript.revoke_reason, transcript.content_sha256, transcript.content,
  EXISTS (
    SELECT 1 FROM app.transcript_finalizations AS covered
    JOIN app.result_finalizations AS finalization
      ON finalization.id = covered.finalization_id AND finalization.school_id = covered.school_id
    WHERE covered.transcript_id = transcript.id AND covered.school_id = transcript.school_id
      AND finalization.status = 'superseded'
  ) AS corrected,
  EXISTS (
    SELECT 1 FROM app.student_overall_results AS overall
    JOIN app.result_finalizations AS finalization
      ON finalization.id = overall.finalization_id AND finalization.school_id = overall.school_id
    WHERE overall.school_id = transcript.school_id AND overall.student_id = transcript.student_id
      AND finalization.term_id IS NULL AND finalization.status = 'finalized'
      AND NOT EXISTS (
        SELECT 1 FROM app.transcript_finalizations AS covered
        JOIN app.result_finalizations AS covered_finalization
          ON covered_finalization.id = covered.finalization_id
         AND covered_finalization.school_id = covered.school_id
        WHERE covered.transcript_id = transcript.id AND covered.school_id = transcript.school_id
          AND covered_finalization.academic_year_id = finalization.academic_year_id
      )
  ) AS new_results`;

function toView(row: TranscriptRow): TranscriptView {
  const stale: TranscriptStaleReason[] = [];
  if (row.status === "issued" && row.corrected) stale.push("corrected");
  if (row.status === "issued" && row.new_results) stale.push("new_results");
  return {
    id: row.id,
    serial_number: row.serial_number,
    status: row.status,
    student_id: row.student_id,
    issued_at: row.issued_at.toISOString(),
    supersedes_id: row.supersedes_id,
    reissue_reason: row.reissue_reason,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoke_reason: row.revoke_reason,
    content_sha256: row.content_sha256,
    needs_reissue: stale.length > 0,
    stale_reasons: stale,
    content: row.content,
  };
}

async function requireTranscriptRow(
  tx: TransactionSql,
  schoolId: string,
  transcriptId: string,
  lock = false,
): Promise<TranscriptRow> {
  const lockClause = lock ? tx`FOR UPDATE OF transcript` : tx``;
  const [row] = await tx<TranscriptRow[]>`
    SELECT ${tx.unsafe(TRANSCRIPT_COLUMNS)}
    FROM app.transcripts AS transcript
    WHERE transcript.id = ${transcriptId}::uuid AND transcript.school_id = ${schoolId}::uuid
    ${lockClause}
  `;
  if (!row)
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Transcript not found");
  return row;
}

async function currentTranscriptRow(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<TranscriptRow | undefined> {
  const [row] = await tx<TranscriptRow[]>`
    SELECT ${tx.unsafe(TRANSCRIPT_COLUMNS)}
    FROM app.transcripts AS transcript
    WHERE transcript.school_id = ${schoolId}::uuid AND transcript.student_id = ${studentId}::uuid
      AND transcript.status = 'issued'
  `;
  return row;
}

async function requireStudent(tx: TransactionSql, schoolId: string, studentId: string) {
  const [student] = await tx<{ id: string }[]>`
    SELECT id FROM app.students WHERE id = ${studentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!student)
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
}

// ---------------------------------------------------------------------------
// Readiness, issue, reissue, revoke, read
// ---------------------------------------------------------------------------

/** What issuing a transcript for this student would do now, and why it cannot if it cannot. */
export async function transcriptReadiness(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<TranscriptReadiness> {
  await requireStudent(tx, schoolId, studentId);
  const years = await loadCoveredYears(tx, schoolId, studentId);
  const current = await currentTranscriptRow(tx, schoolId, studentId);
  const reasons =
    years.length === 0
      ? ["There are no finalized end-of-year results for this student yet."]
      : years.flatMap(yearReasons);
  let state: TranscriptState;
  if (current) {
    state = toView(current).needs_reissue ? "needs_reissue" : "issued";
  } else {
    state = reasons.length > 0 ? "blocked" : "ready";
  }
  return {
    state,
    reasons,
    current_transcript_id: current?.id ?? null,
    years: years.map((year) => ({
      academic_year_id: year.finalization.academic_year_id,
      academic_year_name: year.finalization.year_name,
      grade_level_name: year.finalization.grade_level_name,
      section_name: year.finalization.section_name,
      status: year.result.status,
    })),
    cumulative: years.length > 0 && reasons.length === 0 ? cumulativeOf(years) : null,
  };
}

/** Build, store and cover one transcript; returns its id. Callers check readiness first. */
async function insertTranscript(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  studentId: string,
  years: readonly CoveredYear[],
  reissueOf: { id: string; serial: string; reason: string } | null,
): Promise<string> {
  const serial = newSerial();
  const content = await renderContent(
    tx,
    schoolId,
    userId,
    years,
    serial,
    reissueOf ? { supersedes_serial: reissueOf.serial, reason: reissueOf.reason } : null,
  );
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.transcripts (
      school_id, student_id, serial_number, issued_by_user_id, supersedes_id, reissue_reason,
      content, content_sha256
    )
    VALUES (
      ${schoolId}::uuid, ${studentId}::uuid, ${serial}, ${userId}::uuid,
      ${reissueOf?.id ?? null}::uuid, ${reissueOf?.reason ?? null},
      ${tx.json(content as never)}::jsonb,
      ${createHash("sha256").update(JSON.stringify(content)).digest("hex")}
    )
    RETURNING id
  `;
  await tx`
    INSERT INTO app.transcript_finalizations (transcript_id, school_id, student_id, finalization_id)
    SELECT ${row!.id}::uuid, ${schoolId}::uuid, ${studentId}::uuid, covered
    FROM unnest(${years.map((year) => year.finalization.id)}::uuid[]) AS covered
  `;
  return row!.id;
}

function assertIssuable(years: readonly CoveredYear[]): void {
  if (years.length === 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CERTIFICATE_BLOCKED,
      "There are no finalized end-of-year results for this student yet",
    );
  }
  const reasons = years.flatMap(yearReasons);
  if (reasons.length > 0) {
    throw new CodedHttpException(409, ERROR_CODES.CERTIFICATE_BLOCKED, reasons.join(" "));
  }
}

export async function issueTranscript(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  studentId: string,
): Promise<TranscriptView> {
  await requireStudent(tx, schoolId, studentId);
  const current = await currentTranscriptRow(tx, schoolId, studentId);
  if (current) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "This student already has a transcript; reissue it to bring it up to date",
    );
  }
  const years = await loadCoveredYears(tx, schoolId, studentId);
  assertIssuable(years);
  const id = await insertTranscript(tx, schoolId, userId, studentId, years, null);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "transcripts",
    targetId: id,
    newValues: {
      student_id: studentId,
      finalization_ids: years.map((year) => year.finalization.id),
    },
  });
  return getTranscript(tx, schoolId, id);
}

/** Replace an issued transcript with one built from the student's current results. */
export async function reissueTranscript(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  transcriptId: string,
  reason: string,
): Promise<TranscriptView> {
  const old = await requireTranscriptRow(tx, schoolId, transcriptId, true);
  if (old.status !== "issued") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `A ${old.status} transcript cannot be reissued`,
    );
  }
  const years = await loadCoveredYears(tx, schoolId, old.student_id);
  assertIssuable(years);
  await tx`
    UPDATE app.transcripts SET status = 'superseded'
    WHERE id = ${transcriptId}::uuid AND school_id = ${schoolId}::uuid
  `;
  const id = await insertTranscript(tx, schoolId, userId, old.student_id, years, {
    id: old.id,
    serial: old.serial_number,
    reason,
  });
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "transcripts",
    targetId: id,
    newValues: {
      reason,
      supersedes_transcript_id: transcriptId,
      supersedes_serial_number: old.serial_number,
      finalization_ids: years.map((year) => year.finalization.id),
    },
  });
  return getTranscript(tx, schoolId, id);
}

export async function revokeTranscript(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  transcriptId: string,
  reason: string,
): Promise<TranscriptView> {
  const old = await requireTranscriptRow(tx, schoolId, transcriptId, true);
  if (old.status !== "issued") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `A ${old.status} transcript cannot be revoked`,
    );
  }
  await tx`
    UPDATE app.transcripts SET status = 'revoked', revoked_by_user_id = ${userId}::uuid,
      revoke_reason = ${reason}
    WHERE id = ${transcriptId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "transcripts",
    targetId: transcriptId,
    oldValues: { status: "issued" },
    newValues: { status: "revoked", reason },
  });
  return getTranscript(tx, schoolId, transcriptId);
}

export async function getTranscript(
  tx: TransactionSql,
  schoolId: string,
  transcriptId: string,
): Promise<TranscriptView> {
  return toView(await requireTranscriptRow(tx, schoolId, transcriptId));
}

/** Every transcript of a student, newest first (issued, superseded and revoked). */
export async function listStudentTranscripts(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<TranscriptView[]> {
  const rows = await tx<TranscriptRow[]>`
    SELECT ${tx.unsafe(TRANSCRIPT_COLUMNS)}
    FROM app.transcripts AS transcript
    WHERE transcript.school_id = ${schoolId}::uuid AND transcript.student_id = ${studentId}::uuid
    ORDER BY transcript.issued_at DESC
    LIMIT 100
  `;
  return rows.map(toView);
}
