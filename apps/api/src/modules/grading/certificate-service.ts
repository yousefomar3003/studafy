import { createHash, randomBytes } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { readFinalizationResults, requireFinalization } from "./results-service";

import type { ReportNotes } from "./report-card-service";
import type { FinalizationRow, StoredStudentResult } from "./results-service";
import type { ResultDisplay } from "@studafy/grading-engine";
import type { TransactionSql } from "postgres";

/**
 * Report cards (term finalizations) and certificates (annual finalizations).
 *
 * A certificate is rendered once, at issue time, from the finalized result rows, and stored whole
 * in `content` with its SHA-256. Displaying, printing or verifying a certificate reads that
 * content; nothing is recomputed or re-read from live configuration. A certificate is issued only
 * for a complete result — never with invented marks or a default pass.
 */

export type CertificateKind = "annual_certificate" | "term_report";

export interface CertificateContent {
  version: 1;
  kind: CertificateKind;
  serial_number: string;
  issued_at: string;
  school: { id: string; name: string };
  academic_year: { id: string; code: string; name: string };
  term: { id: string; name: string } | null;
  student: { id: string; first_name: string; last_name: string; admission_number: string };
  grade_level_name: string;
  section_name: string;
  subjects: {
    code: string;
    name: string;
    requirement: string;
    marks_obtained: number | null;
    max_marks: number;
    percentage: number | null;
    grade_label: string | null;
    passed: boolean | null;
    exempt: boolean;
    terms: { term_id: string | null; term_name: string | null; percentage: number | null }[];
    /** The subject teacher's comment. Absent on certificates issued before report card notes. */
    comment?: string;
    /** Graded with descriptors instead of marks (absent on certificates issued before). */
    descriptive?: boolean;
    skills?: {
      name: string;
      category_name: string;
      term_name: string | null;
      descriptor_label: string | null;
    }[];
  }[];
  overall: {
    average_percentage: number | null;
    total_obtained: number | null;
    total_max: number | null;
    grade_label: string | null;
    /** The final result in the grade's format; absent on certificates issued before formats. */
    display?: ResultDisplay | null;
    subjects_failed: number;
    academic_status: string;
  };
  /**
   * Report card notes and attendance, as finalized. Absent on certificates issued before report
   * card notes existed, and on ones whose finalization predates them.
   */
  report?: ReportNotes;
  finalization: { id: string; version: number; finalized_at: string };
  issued_by: { user_id: string; name: string | null };
  reissue: { supersedes_serial: string; reason: string } | null;
}

export interface CertificateView {
  id: string;
  kind: CertificateKind;
  serial_number: string;
  status: "issued" | "superseded" | "revoked";
  academic_year_id: string;
  student_id: string;
  finalization_id: string;
  issued_at: string;
  supersedes_id: string | null;
  reissue_reason: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  content_sha256: string;
  /** The finalization it came from was corrected since: reissue to reflect the correction. */
  needs_reissue: boolean;
  content: CertificateContent;
}

interface CertificateRow {
  id: string;
  kind: CertificateKind;
  serial_number: string;
  status: "issued" | "superseded" | "revoked";
  academic_year_id: string;
  student_id: string;
  finalization_id: string;
  issued_at: Date;
  supersedes_id: string | null;
  reissue_reason: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  content_sha256: string;
  content: CertificateContent;
  finalization_status: "finalized" | "superseded";
}

const CERTIFICATE_COLUMNS = `
  certificate.id, certificate.kind, certificate.serial_number, certificate.status,
  certificate.academic_year_id, certificate.student_id, certificate.finalization_id,
  certificate.issued_at, certificate.supersedes_id, certificate.reissue_reason,
  certificate.revoked_at, certificate.revoke_reason, certificate.content_sha256,
  certificate.content, finalization.status AS finalization_status`;

function toView(row: CertificateRow): CertificateView {
  return {
    id: row.id,
    kind: row.kind,
    serial_number: row.serial_number,
    status: row.status,
    academic_year_id: row.academic_year_id,
    student_id: row.student_id,
    finalization_id: row.finalization_id,
    issued_at: row.issued_at.toISOString(),
    supersedes_id: row.supersedes_id,
    reissue_reason: row.reissue_reason,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoke_reason: row.revoke_reason,
    content_sha256: row.content_sha256,
    needs_reissue: row.status === "issued" && row.finalization_status === "superseded",
    content: row.content,
  };
}

/** Readable, unambiguous serial: year code, kind, and 10 random Crockford base32 characters. */
function newSerial(yearCode: string, kind: CertificateKind): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(10);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet.charAt(byte % 32);
  return `${yearCode}-${kind === "annual_certificate" ? "C" : "R"}-${suffix}`;
}

/** Why a student's finalized result cannot carry a certificate, if it cannot. */
export function blockingReasons(result: {
  status: StoredStudentResult["status"];
  subjects: readonly Pick<StoredStudentResult["subjects"][number], "status" | "subject_name">[];
}): string[] {
  const reasons: string[] = [];
  if (result.status !== "complete") reasons.push("The overall result is incomplete.");
  for (const subject of result.subjects) {
    if (subject.status === "incomplete") reasons.push(`${subject.subject_name} is incomplete.`);
  }
  return reasons;
}

interface RenderContext {
  school_name: string;
  year_code: string;
  year_name: string;
  section_name: string;
  grade_level_name: string;
  term_name: string | null;
  issuer_name: string | null;
  terms: { id: string; name: string }[];
}

/** What every certificate of one finalization shares: names of the school, year, section, term, issuer. */
async function loadRenderContext(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  finalization: FinalizationRow,
): Promise<RenderContext> {
  const [context] = await tx<Omit<RenderContext, "terms">[]>`
    SELECT school.name AS school_name, year.code AS year_code, year.name AS year_name,
           section.name AS section_name, grade.name AS grade_level_name, term.name AS term_name,
           (SELECT display_name FROM app.users WHERE id = ${userId}::uuid AND school_id = ${schoolId}::uuid) AS issuer_name
    FROM app.result_finalizations AS finalization
    JOIN app.schools AS school ON school.id = finalization.school_id
    JOIN app.academic_years AS year ON year.id = finalization.academic_year_id AND year.school_id = finalization.school_id
    JOIN app.sections AS section ON section.id = finalization.section_id AND section.school_id = finalization.school_id
    JOIN app.grade_levels AS grade ON grade.id = section.grade_level_id AND grade.school_id = section.school_id
    LEFT JOIN app.terms AS term ON term.id = finalization.term_id AND term.school_id = finalization.school_id
    WHERE finalization.id = ${finalization.id}::uuid AND finalization.school_id = ${schoolId}::uuid
  `;
  const terms = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM app.terms
    WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${finalization.academic_year_id}::uuid
  `;
  return { ...context!, terms };
}

function renderContent(
  context: RenderContext,
  schoolId: string,
  userId: string,
  finalization: FinalizationRow,
  result: StoredStudentResult,
  kind: CertificateKind,
  serial: string,
  reissue: CertificateContent["reissue"],
): CertificateContent {
  const terms = context.terms;
  return {
    version: 1,
    kind,
    serial_number: serial,
    issued_at: new Date().toISOString(),
    school: { id: schoolId, name: context.school_name },
    academic_year: {
      id: finalization.academic_year_id,
      code: context.year_code,
      name: context.year_name,
    },
    term: finalization.term_id ? { id: finalization.term_id, name: context.term_name ?? "" } : null,
    student: {
      id: result.student_id,
      first_name: result.first_name,
      last_name: result.last_name,
      admission_number: result.admission_number,
    },
    grade_level_name: context.grade_level_name,
    section_name: context.section_name,
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
        passed: subject.passed,
        exempt: subject.status === "exempt",
        terms: subject.terms.map((term) => ({
          term_id: term.term_id,
          term_name: terms.find((t) => t.id === term.term_id)?.name ?? null,
          percentage: term.percentage,
        })),
        ...(subject.comment ? { comment: subject.comment } : {}),
        ...(subject.is_descriptive
          ? {
              descriptive: true,
              skills: subject.skills.map((skill) => ({
                name: skill.name,
                category_name: skill.category_name,
                term_name: terms.find((t) => t.id === skill.term_id)?.name ?? null,
                descriptor_label: skill.descriptor_label,
              })),
            }
          : {}),
      })),
    overall: {
      average_percentage: result.average_percentage,
      total_obtained: result.total_obtained,
      total_max: result.total_max,
      grade_label: result.grade_label,
      display: result.result_display,
      subjects_failed: result.subjects_failed,
      academic_status: result.academic_status,
    },
    ...(result.report ? { report: result.report } : {}),
    finalization: {
      id: finalization.id,
      version: finalization.version,
      finalized_at: finalization.finalized_at.toISOString(),
    },
    issued_by: { user_id: userId, name: context.issuer_name },
    reissue,
  };
}

/** Rows per multi-row INSERT of certificates (each carries its rendered content). */
const INSERT_CHUNK = 200;

/**
 * Render and insert certificates for students of one finalization: the shared names are read once
 * and the rows go in as multi-row INSERTs, instead of three reads and an INSERT per student.
 * Returns the new ids in the order of `items`.
 */
async function insertCertificates(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  finalization: FinalizationRow,
  items: {
    result: StoredStudentResult;
    reissueOf: { id: string; serial: string; reason: string } | null;
  }[],
): Promise<string[]> {
  if (items.length === 0) return [];
  const kind: CertificateKind =
    finalization.term_id === null ? "annual_certificate" : "term_report";
  const context = await loadRenderContext(tx, schoolId, userId, finalization);
  const rows = items.map(({ result, reissueOf }) => {
    const serial = newSerial(context.year_code, kind);
    const content = renderContent(
      context,
      schoolId,
      userId,
      finalization,
      result,
      kind,
      serial,
      reissueOf ? { supersedes_serial: reissueOf.serial, reason: reissueOf.reason } : null,
    );
    return {
      student_id: result.student_id,
      serial_number: serial,
      supersedes_id: reissueOf?.id ?? null,
      reissue_reason: reissueOf?.reason ?? null,
      content,
      content_sha256: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    };
  });
  const idBySerial = new Map<string, string>();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const inserted = await tx<{ id: string; serial_number: string }[]>`
      INSERT INTO app.certificates (
        school_id, academic_year_id, student_id, finalization_id, kind, serial_number,
        issued_by_user_id, supersedes_id, reissue_reason, content, content_sha256
      )
      SELECT ${schoolId}::uuid, ${finalization.academic_year_id}::uuid, x.student_id,
             ${finalization.id}::uuid, ${kind}, x.serial_number, ${userId}::uuid,
             x.supersedes_id, x.reissue_reason, x.content, x.content_sha256
      FROM jsonb_to_recordset(${tx.json(chunk as never)}::jsonb) AS x(
        student_id uuid, serial_number text, supersedes_id uuid, reissue_reason text,
        content jsonb, content_sha256 text
      )
      RETURNING id, serial_number
    `;
    for (const row of inserted) idBySerial.set(row.serial_number, row.id);
  }
  return rows.map((row) => idBySerial.get(row.serial_number)!);
}

// ---------------------------------------------------------------------------
// Readiness, issue, reissue, revoke
// ---------------------------------------------------------------------------

export type CertificateState = "ready" | "issued" | "needs_reissue" | "blocked";

export interface ReadinessRow {
  student_id: string;
  first_name: string;
  last_name: string;
  state: CertificateState;
  reasons: string[];
  certificate_id: string | null;
}

export async function certificateReadiness(
  tx: TransactionSql,
  schoolId: string,
  finalizationId: string,
): Promise<ReadinessRow[]> {
  const finalization = await requireFinalization(tx, schoolId, finalizationId);
  const results = await readFinalizationResults(tx, schoolId, finalizationId);
  const issued = await tx<{ id: string; student_id: string; finalization_id: string }[]>`
    SELECT id, student_id, finalization_id FROM app.certificates
    WHERE school_id = ${schoolId}::uuid AND status = 'issued'
      AND student_id = ANY (${results.map((r) => r.student_id)}::uuid[])
      AND finalization_id IN (
        SELECT id FROM app.result_finalizations
        WHERE school_id = ${schoolId}::uuid AND section_id = ${finalization.section_id}::uuid
          AND term_id IS NOT DISTINCT FROM ${finalization.term_id}::uuid
      )
  `;
  return results.map((result) =>
    readinessRow(
      finalization,
      result,
      blockingReasons(result),
      issued.find((row) => row.student_id === result.student_id),
    ),
  );
}

/** One student's certificate state for a finalization: what {@link certificateReadiness} reports. */
function readinessRow(
  finalization: Pick<FinalizationRow, "id" | "status">,
  result: { student_id: string; first_name: string; last_name: string },
  reasons: string[],
  certificate: { id: string; finalization_id: string } | undefined,
): ReadinessRow {
  let state: CertificateState;
  if (certificate) {
    state = certificate.finalization_id === finalization.id ? "issued" : "needs_reissue";
  } else {
    state = reasons.length > 0 ? "blocked" : "ready";
  }
  if (finalization.status !== "finalized" && state === "ready") state = "blocked";
  return {
    student_id: result.student_id,
    first_name: result.first_name,
    last_name: result.last_name,
    state,
    reasons:
      finalization.status !== "finalized"
        ? ["These results were superseded by a correction."]
        : state === "blocked"
          ? reasons
          : [],
    certificate_id: certificate?.id ?? null,
  };
}

/**
 * {@link certificateReadiness} for many finalizations in three queries (the year overview reads
 * every section's annual results). Reads only what readiness needs — result status and the names
 * of incomplete subjects — not the stored snapshots.
 */
export async function certificateReadinessMany(
  tx: TransactionSql,
  schoolId: string,
  finalizations: readonly Pick<FinalizationRow, "id" | "section_id" | "term_id" | "status">[],
): Promise<Map<string, ReadinessRow[]>> {
  const out = new Map<string, ReadinessRow[]>();
  if (finalizations.length === 0) return out;
  const ids = finalizations.map((finalization) => finalization.id);
  const sectionIds = [...new Set(finalizations.map((finalization) => finalization.section_id))];
  const [overall, incomplete, issued] = await Promise.all([
    tx<
      {
        finalization_id: string;
        student_id: string;
        first_name: string;
        last_name: string;
        status: StoredStudentResult["status"];
      }[]
    >`
      SELECT overall.finalization_id, overall.student_id, student.first_name, student.last_name,
             overall.status
      FROM app.student_overall_results AS overall
      JOIN app.students AS student ON student.id = overall.student_id AND student.school_id = overall.school_id
      WHERE overall.school_id = ${schoolId}::uuid AND overall.finalization_id = ANY (${ids}::uuid[])
      ORDER BY student.last_name, student.first_name, student.id
    `,
    tx<{ finalization_id: string; student_id: string; subject_name: string }[]>`
      SELECT result.finalization_id, result.student_id,
             result.config_snapshot->'subject'->>'name' AS subject_name
      FROM app.student_subject_results AS result
      WHERE result.school_id = ${schoolId}::uuid AND result.finalization_id = ANY (${ids}::uuid[])
        AND result.status = 'incomplete'
    `,
    tx<
      {
        id: string;
        student_id: string;
        finalization_id: string;
        section_id: string;
        term_id: string | null;
      }[]
    >`
      SELECT certificate.id, certificate.student_id, certificate.finalization_id,
             finalization.section_id, finalization.term_id
      FROM app.certificates AS certificate
      JOIN app.result_finalizations AS finalization
        ON finalization.id = certificate.finalization_id AND finalization.school_id = certificate.school_id
      WHERE certificate.school_id = ${schoolId}::uuid AND certificate.status = 'issued'
        AND finalization.section_id = ANY (${sectionIds}::uuid[])
    `,
  ]);
  const incompleteByStudent = new Map<string, string[]>();
  for (const row of incomplete) {
    const key = `${row.finalization_id}|${row.student_id}`;
    const names = incompleteByStudent.get(key);
    // Subject order only shapes the reason text; keep readFinalizationResults' (by name).
    if (names) names.push(row.subject_name);
    else incompleteByStudent.set(key, [row.subject_name]);
  }
  for (const finalization of finalizations) {
    const rows = overall
      .filter((row) => row.finalization_id === finalization.id)
      .map((row) => {
        const names = (incompleteByStudent.get(`${finalization.id}|${row.student_id}`) ?? []).sort(
          (a, b) => a.localeCompare(b),
        );
        const reasons = blockingReasons({
          status: row.status,
          subjects: names.map((name) => ({ status: "incomplete" as const, subject_name: name })),
        });
        const certificate = issued.find(
          (candidate) =>
            candidate.student_id === row.student_id &&
            candidate.section_id === finalization.section_id &&
            candidate.term_id === finalization.term_id,
        );
        return readinessRow(finalization, row, reasons, certificate);
      });
    out.set(finalization.id, rows);
  }
  return out;
}

/**
 * Issue certificates (or report cards) from a current finalization. With `studentIds`, only those
 * students; a named student whose result is incomplete is a CERTIFICATE_BLOCKED error. Without,
 * every ready student is issued and the rest are reported back.
 */
export async function issueCertificates(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  finalizationId: string,
  studentIds: string[] | undefined,
): Promise<{ issued: string[]; skipped: ReadinessRow[] }> {
  const finalization = await requireFinalization(tx, schoolId, finalizationId);
  if (finalization.status !== "finalized") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "These results were superseded by a correction; issue from the current version",
    );
  }
  const readiness = await certificateReadiness(tx, schoolId, finalizationId);
  const wanted = studentIds
    ? readiness.filter((row) => studentIds.includes(row.student_id))
    : readiness;
  if (studentIds && wanted.length !== new Set(studentIds).size) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.RESOURCE_NOT_FOUND,
      "A student is not part of these results",
    );
  }
  if (studentIds) {
    const blocked = wanted.filter((row) => row.state === "blocked");
    if (blocked.length > 0) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CERTIFICATE_BLOCKED,
        blocked
          .map((row) => `${row.first_name} ${row.last_name}: ${row.reasons.join(" ")}`)
          .join("; "),
      );
    }
  }
  const results = await readFinalizationResults(tx, schoolId, finalizationId);
  const issued = await insertCertificates(
    tx,
    schoolId,
    userId,
    finalization,
    wanted
      .filter((candidate) => candidate.state === "ready")
      .map((row) => ({
        result: results.find((candidate) => candidate.student_id === row.student_id)!,
        reissueOf: null,
      })),
  );
  if (issued.length > 0) {
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "certificates",
      targetId: issued.length === 1 ? issued[0]! : finalizationId,
      newValues: { finalization_id: finalizationId, certificate_ids: issued },
    });
  }
  return { issued, skipped: wanted.filter((row) => row.state !== "ready") };
}

async function requireCertificateRow(
  tx: TransactionSql,
  schoolId: string,
  certificateId: string,
  lock = false,
): Promise<CertificateRow> {
  const lockClause = lock ? tx`FOR UPDATE OF certificate` : tx``;
  const [row] = await tx<CertificateRow[]>`
    SELECT ${tx.unsafe(CERTIFICATE_COLUMNS)}
    FROM app.certificates AS certificate
    JOIN app.result_finalizations AS finalization
      ON finalization.id = certificate.finalization_id AND finalization.school_id = certificate.school_id
    WHERE certificate.id = ${certificateId}::uuid AND certificate.school_id = ${schoolId}::uuid
    ${lockClause}
  `;
  if (!row)
    throw new CodedHttpException(404, ERROR_CODES.CERTIFICATE_NOT_FOUND, "Certificate not found");
  return row;
}

/**
 * Replace an issued certificate with one rendered from the current finalization of the same
 * section and period (typically after a correction). The old one is kept, marked superseded.
 */
export async function reissueCertificate(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  certificateId: string,
  reason: string,
): Promise<CertificateView> {
  const old = await requireCertificateRow(tx, schoolId, certificateId, true);
  if (old.status !== "issued") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `A ${old.status} certificate cannot be reissued`,
    );
  }
  const previous = await requireFinalization(tx, schoolId, old.finalization_id);
  const [current] = await tx<{ id: string }[]>`
    SELECT id FROM app.result_finalizations
    WHERE school_id = ${schoolId}::uuid AND section_id = ${previous.section_id}::uuid
      AND term_id IS NOT DISTINCT FROM ${previous.term_id}::uuid AND status = 'finalized'
  `;
  if (!current) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RESULT_FINALIZATION_NOT_FOUND,
      "There are no current finalized results to reissue from",
    );
  }
  const finalization = await requireFinalization(tx, schoolId, current.id);
  const [result] = await readFinalizationResults(tx, schoolId, current.id, {
    studentId: old.student_id,
  });
  if (!result) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CERTIFICATE_BLOCKED,
      "The student is not part of the current results",
    );
  }
  const reasons = blockingReasons(result);
  if (reasons.length > 0) {
    throw new CodedHttpException(409, ERROR_CODES.CERTIFICATE_BLOCKED, reasons.join(" "));
  }
  await tx`
    UPDATE app.certificates SET status = 'superseded'
    WHERE id = ${certificateId}::uuid AND school_id = ${schoolId}::uuid
  `;
  const [newId] = await insertCertificates(tx, schoolId, userId, finalization, [
    { result, reissueOf: { id: old.id, serial: old.serial_number, reason } },
  ]);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "certificates",
    targetId: newId!,
    newValues: {
      reason,
      finalization_id: current.id,
      supersedes_certificate_id: certificateId,
      supersedes_serial_number: old.serial_number,
    },
  });
  return getCertificate(tx, schoolId, newId!);
}

export async function revokeCertificate(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  certificateId: string,
  reason: string,
): Promise<CertificateView> {
  const old = await requireCertificateRow(tx, schoolId, certificateId, true);
  if (old.status !== "issued") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      `A ${old.status} certificate cannot be revoked`,
    );
  }
  await tx`
    UPDATE app.certificates SET status = 'revoked', revoked_by_user_id = ${userId}::uuid,
      revoke_reason = ${reason}
    WHERE id = ${certificateId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "certificates",
    targetId: certificateId,
    oldValues: { status: "issued" },
    newValues: { status: "revoked", reason },
  });
  return getCertificate(tx, schoolId, certificateId);
}

export async function getCertificate(
  tx: TransactionSql,
  schoolId: string,
  certificateId: string,
): Promise<CertificateView> {
  return toView(await requireCertificateRow(tx, schoolId, certificateId));
}

export async function listCertificates(
  tx: TransactionSql,
  schoolId: string,
  filter: { yearId?: string; studentId?: string; finalizationId?: string; sectionId?: string },
): Promise<CertificateView[]> {
  const conditions = [
    filter.yearId ? tx`AND certificate.academic_year_id = ${filter.yearId}::uuid` : tx``,
    filter.studentId ? tx`AND certificate.student_id = ${filter.studentId}::uuid` : tx``,
    filter.finalizationId
      ? tx`AND certificate.finalization_id = ${filter.finalizationId}::uuid`
      : tx``,
    filter.sectionId ? tx`AND finalization.section_id = ${filter.sectionId}::uuid` : tx``,
  ];
  const rows = await tx<CertificateRow[]>`
    SELECT ${tx.unsafe(CERTIFICATE_COLUMNS)}
    FROM app.certificates AS certificate
    JOIN app.result_finalizations AS finalization
      ON finalization.id = certificate.finalization_id AND finalization.school_id = certificate.school_id
    WHERE certificate.school_id = ${schoolId}::uuid
      ${conditions[0]!} ${conditions[1]!} ${conditions[2]!} ${conditions[3]!}
    ORDER BY certificate.issued_at DESC
    LIMIT 500
  `;
  return rows.map(toView);
}
