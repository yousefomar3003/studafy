import { createHash, randomBytes } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { readFinalizationResults, requireFinalization } from "./results-service";

import type { FinalizationRow, StoredStudentResult } from "./results-service";
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
  }[];
  overall: {
    average_percentage: number | null;
    total_obtained: number | null;
    total_max: number | null;
    grade_label: string | null;
    subjects_failed: number;
    academic_status: string;
  };
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
export function blockingReasons(result: StoredStudentResult): string[] {
  const reasons: string[] = [];
  if (result.status !== "complete") reasons.push("The overall result is incomplete.");
  for (const subject of result.subjects) {
    if (subject.status === "incomplete") reasons.push(`${subject.subject_name} is incomplete.`);
  }
  return reasons;
}

async function renderContent(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  finalization: FinalizationRow,
  result: StoredStudentResult,
  kind: CertificateKind,
  serial: string,
  reissue: CertificateContent["reissue"],
): Promise<CertificateContent> {
  const [context] = await tx<
    {
      school_name: string;
      year_code: string;
      year_name: string;
      section_name: string;
      grade_level_name: string;
      term_name: string | null;
      issuer_name: string | null;
    }[]
  >`
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
  return {
    version: 1,
    kind,
    serial_number: serial,
    issued_at: new Date().toISOString(),
    school: { id: schoolId, name: context!.school_name },
    academic_year: {
      id: finalization.academic_year_id,
      code: context!.year_code,
      name: context!.year_name,
    },
    term: finalization.term_id
      ? { id: finalization.term_id, name: context!.term_name ?? "" }
      : null,
    student: {
      id: result.student_id,
      first_name: result.first_name,
      last_name: result.last_name,
      admission_number: result.admission_number,
    },
    grade_level_name: context!.grade_level_name,
    section_name: context!.section_name,
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
      })),
    overall: {
      average_percentage: result.average_percentage,
      total_obtained: result.total_obtained,
      total_max: result.total_max,
      grade_label: result.grade_label,
      subjects_failed: result.subjects_failed,
      academic_status: result.academic_status,
    },
    finalization: {
      id: finalization.id,
      version: finalization.version,
      finalized_at: finalization.finalized_at.toISOString(),
    },
    issued_by: { user_id: userId, name: context!.issuer_name },
    reissue,
  };
}

async function insertCertificate(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  finalization: FinalizationRow,
  result: StoredStudentResult,
  reissueOf: { id: string; serial: string; reason: string } | null,
): Promise<string> {
  const kind: CertificateKind =
    finalization.term_id === null ? "annual_certificate" : "term_report";
  const [year] = await tx<{ code: string }[]>`
    SELECT code FROM app.academic_years WHERE id = ${finalization.academic_year_id}::uuid AND school_id = ${schoolId}::uuid
  `;
  const serial = newSerial(year!.code, kind);
  const content = await renderContent(
    tx,
    schoolId,
    userId,
    finalization,
    result,
    kind,
    serial,
    reissueOf ? { supersedes_serial: reissueOf.serial, reason: reissueOf.reason } : null,
  );
  const sha = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.certificates (
      school_id, academic_year_id, student_id, finalization_id, kind, serial_number,
      issued_by_user_id, supersedes_id, reissue_reason, content, content_sha256
    ) VALUES (
      ${schoolId}::uuid, ${finalization.academic_year_id}::uuid, ${result.student_id}::uuid,
      ${finalization.id}::uuid, ${kind}, ${serial}, ${userId}::uuid,
      ${reissueOf?.id ?? null}::uuid, ${reissueOf?.reason ?? null},
      ${tx.json(content as never)}, ${sha}
    )
    RETURNING id
  `;
  return row!.id;
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
  return results.map((result) => {
    const certificate = issued.find((row) => row.student_id === result.student_id);
    const reasons = blockingReasons(result);
    let state: CertificateState;
    if (certificate) {
      state = certificate.finalization_id === finalizationId ? "issued" : "needs_reissue";
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
  });
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
  const issued: string[] = [];
  for (const row of wanted.filter((candidate) => candidate.state === "ready")) {
    const result = results.find((candidate) => candidate.student_id === row.student_id)!;
    issued.push(await insertCertificate(tx, schoolId, userId, finalization, result, null));
  }
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
  const newId = await insertCertificate(tx, schoolId, userId, finalization, result, {
    id: old.id,
    serial: old.serial_number,
    reason,
  });
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "certificates",
    targetId: newId,
    newValues: {
      reason,
      finalization_id: current.id,
      supersedes_certificate_id: certificateId,
      supersedes_serial_number: old.serial_number,
    },
  });
  return getCertificate(tx, schoolId, newId);
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
