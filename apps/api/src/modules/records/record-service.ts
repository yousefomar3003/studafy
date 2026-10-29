/**
 * One subject's record: reading, writing, revealing, and the documents behind document fields
 * (docs/modules/student-records.md).
 *
 * Who sees what is decided in three layers. Row scope is the database's: app.record_answers'
 * role_scope_visibility policy reuses app.can_read_student, so a teacher outside the student's
 * classes and a parent of another family read nothing (FINANCE, which cannot read students at all,
 * reads through the identity transaction instead). Field scope is this module's: an audience reads
 * only the fields whose visibility reaches it (isFieldVisibleTo), and never a sensitive one unless
 * it is leadership. Value scope is ADR-019's: a sensitive value leaves this module as its mask,
 * except through revealValue, which is audited like a write.
 */

import { ERROR_CODES, PERMISSIONS, ROLES } from "@studafy/constants";
import {
  RecordKeyUnavailableError,
  RecordSealBrokenError,
  isFieldVisibleTo,
  normalizeRecordValue,
  openRecordValue,
  sealRecordValue,
} from "@studafy/records";

import { CodedHttpException } from "../../coded-http-exception";
import { buildPermanentKey, promoteTempObject } from "../../lib/storage";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { hasPermission } from "../../middleware/authz";
import { getContentClass } from "../storage/content-classes";
import {
  assertStorageUploadQuota,
  recordStorageUpload,
  releaseStorageUsage,
} from "../storage/quota-service";
import { inspectStagedUpload } from "../storage/service";

import { getPublishedForm } from "./template-service";

import type {
  RecordDocumentDto,
  RecordEntryDto,
  RecordFieldDefinitionDto,
  SubjectRecordsDto,
} from "./schemas";
import type { PublishedField } from "./template-service";
import type { StorageService } from "../../lib/storage";
import type { Role } from "@studafy/constants";
import type {
  RecordAudience,
  RecordDocumentStatus,
  RecordFieldOption,
  RecordFieldSensitivity,
  RecordFieldType,
  RecordFieldVisibility,
  RecordKeyring,
  RecordSubjectKind,
  RecordValue,
} from "@studafy/records";
import type { TransactionSql } from "postgres";

export interface RecordSubject {
  kind: RecordSubjectKind;
  id: string;
}

/** Content classes (content-classes.ts) a document field's upload must have been staged under. */
export const RECORD_DOCUMENT_CONTENT_CLASS = "record.document";
export const RECORD_SENSITIVE_DOCUMENT_CONTENT_CLASS = "record.sensitiveDocument";

/** Download URL lifetimes: ordinary documents as other downloads; sensitive ones a minute. */
export const RECORD_DOCUMENT_DOWNLOAD_TTL_SECONDS = 5 * 60;
export const RECORD_SENSITIVE_DOCUMENT_DOWNLOAD_TTL_SECONDS = 60;
const EXPIRING_WITHIN_DAYS = 30;

const LEADERSHIP: readonly Role[] = [ROLES.SUPER_ADMIN, ROLES.ORG_ADMIN, ROLES.PRINCIPAL];

/**
 * The widest audience the caller's roles give them. Leadership (who alone may write and reveal)
 * reads everything; then finance; then a teacher; then a parent.
 */
export function audienceFor(roles: readonly Role[]): RecordAudience | null {
  if (!hasPermission(roles, PERMISSIONS.STUDENT_RECORD_READ)) return null;
  if (roles.some((role) => LEADERSHIP.includes(role))) return "staff";
  if (roles.includes(ROLES.FINANCE)) return "finance";
  if (roles.includes(ROLES.INSTRUCTOR)) return "teachers";
  if (roles.includes(ROLES.PARENT)) return "parent";
  return null;
}

function subjectNotFound(): never {
  throw new CodedHttpException(
    404,
    ERROR_CODES.RECORD_SUBJECT_NOT_FOUND,
    "No record found for that person",
  );
}

/**
 * The subject exists and the caller may see it. Student visibility is the RLS policy on
 * app.students (or the identity transaction for finance); a parent's record is leadership's and
 * finance's only.
 */
export async function assertSubjectReadable(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
  audience: RecordAudience,
): Promise<void> {
  if (subject.kind === "student") {
    const [row] = await tx<{ id: string }[]>`
      SELECT id FROM app.students WHERE school_id = ${schoolId}::uuid AND id = ${subject.id}::uuid
    `;
    if (!row) subjectNotFound();
    return;
  }
  if (audience !== "staff" && audience !== "finance") subjectNotFound();
  const [row] = await tx<{ id: string }[]>`
    SELECT u.id
    FROM app.users AS u
    WHERE u.school_id = ${schoolId}::uuid AND u.id = ${subject.id}::uuid
      AND EXISTS (
        SELECT 1 FROM app.user_roles AS role
        WHERE role.school_id = u.school_id AND role.user_id = u.id AND role.role = 'PARENT'
      )
  `;
  if (!row) subjectNotFound();
}

interface AnswerRow {
  id: string;
  field_id: string;
  field_version_id: string;
  value: RecordValue | null;
  value_ciphertext: Uint8Array | null;
  value_key_id: string | null;
  value_mask: string | null;
  updated_at: Date;
  answered_version: number;
  answered_field_type: RecordFieldType;
  answered_label_en: string;
  answered_label_ar: string;
  answered_help_en: string | null;
  answered_help_ar: string | null;
  answered_required: boolean;
  answered_options: RecordFieldOption[];
  answered_sort_order: number;
  answered_visibility: RecordFieldVisibility;
  answered_sensitivity: RecordFieldSensitivity;
  answered_has_expiry: boolean;
  document_status: RecordDocumentStatus | null;
  document_storage_key: string | null;
  document_file_name: string | null;
  document_mime_type: string | null;
  document_size_bytes: string | null;
  document_sensitive: boolean | null;
  document_uploaded_at: Date | null;
  document_verified_at: Date | null;
  document_expires_on: string | null;
}

function subjectColumn(subject: RecordSubject) {
  return subject.kind === "student" ? "student_id" : "parent_user_id";
}

async function loadAnswers(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
): Promise<AnswerRow[]> {
  return tx<AnswerRow[]>`
    SELECT a.id, a.field_id, a.field_version_id, a.value, a.value_ciphertext, a.value_key_id,
           a.value_mask, a.updated_at,
           tv.version AS answered_version,
           fv.field_type AS answered_field_type, fv.label_en AS answered_label_en,
           fv.label_ar AS answered_label_ar, fv.help_en AS answered_help_en,
           fv.help_ar AS answered_help_ar, fv.required AS answered_required,
           fv.options AS answered_options, fv.sort_order AS answered_sort_order,
           fv.visibility AS answered_visibility, fv.sensitivity AS answered_sensitivity,
           fv.has_expiry AS answered_has_expiry,
           d.status AS document_status, d.storage_key AS document_storage_key,
           d.original_file_name AS document_file_name, d.mime_type AS document_mime_type,
           d.size_bytes::text AS document_size_bytes, d.sensitive AS document_sensitive,
           d.uploaded_at AS document_uploaded_at, d.verified_at AS document_verified_at,
           to_char(d.expires_on, 'YYYY-MM-DD') AS document_expires_on
    FROM app.record_answers AS a
    JOIN app.record_field_versions AS fv
      ON fv.id = a.field_version_id AND fv.school_id = a.school_id
    JOIN app.record_template_versions AS tv
      ON tv.id = fv.template_version_id AND tv.school_id = fv.school_id
    LEFT JOIN app.record_documents AS d ON d.answer_id = a.id AND d.school_id = a.school_id
    WHERE a.school_id = ${schoolId}::uuid
      AND a.subject_kind = ${subject.kind}::app.record_subject_kind
      AND a.${tx(subjectColumn(subject))} = ${subject.id}::uuid
  `;
}

function toDefinition(field: PublishedField): RecordFieldDefinitionDto {
  return {
    id: field.id,
    field_type: field.field_type,
    label_en: field.label_en,
    label_ar: field.label_ar,
    help_en: field.help_en,
    help_ar: field.help_ar,
    required: field.required,
    options: field.options,
    sort_order: field.sort_order,
    visibility: field.visibility,
    sensitivity: field.sensitivity,
    has_expiry: field.has_expiry,
  };
}

function answeredDefinition(row: AnswerRow): RecordFieldDefinitionDto {
  return {
    id: row.field_id,
    field_type: row.answered_field_type,
    label_en: row.answered_label_en,
    label_ar: row.answered_label_ar,
    help_en: row.answered_help_en,
    help_ar: row.answered_help_ar,
    required: row.answered_required,
    options: row.answered_options,
    sort_order: row.answered_sort_order,
    visibility: row.answered_visibility,
    sensitivity: row.answered_sensitivity,
    has_expiry: row.answered_has_expiry,
  };
}

/** Today in UTC as YYYY-MM-DD, and the same `days` later. */
function isoDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function expiryState(expiresOn: string | null): RecordDocumentDto["expiry_state"] {
  if (expiresOn === null) return "none";
  if (expiresOn < isoDay()) return "expired";
  if (expiresOn <= isoDay(EXPIRING_WITHIN_DAYS)) return "expiring";
  return "valid";
}

function toDocument(row: AnswerRow): RecordDocumentDto | null {
  if (row.document_status === null) return null;
  return {
    status: row.document_status,
    file_name: row.document_file_name,
    content_type: row.document_mime_type,
    size_bytes: row.document_size_bytes === null ? null : Number(row.document_size_bytes),
    sensitive: row.document_sensitive ?? false,
    uploaded_at: row.document_uploaded_at?.toISOString() ?? null,
    verified_at: row.document_verified_at?.toISOString() ?? null,
    expires_on: row.document_expires_on,
    expiry_state: expiryState(row.document_expires_on),
  };
}

function hasValue(row: AnswerRow | undefined): boolean {
  return row !== undefined && (row.value !== null || row.value_ciphertext !== null);
}

function hasFile(row: AnswerRow | undefined): boolean {
  return row !== undefined && row.document_status !== null && row.document_status !== "missing";
}

function entryFor(
  field: RecordFieldDefinitionDto,
  row: AnswerRow | undefined,
  archived: boolean,
  currentFieldVersionId: string | null,
): RecordEntryDto {
  const sensitive = field.sensitivity === "sensitive" || row?.value_ciphertext != null;
  const answered = field.field_type === "document" ? hasFile(row) : hasValue(row);
  const differs = row !== undefined && row.field_version_id !== currentFieldVersionId;
  return {
    field,
    archived,
    // A sensitive value never leaves as anything but its mask (ADR-019).
    value: sensitive ? null : (row?.value ?? null),
    masked: sensitive && row?.value_ciphertext != null,
    mask: sensitive ? (row?.value_mask ?? null) : null,
    answered,
    missing: !archived && field.required && !answered,
    answered_in_version: row?.answered_version ?? null,
    answered_field: differs && !archived && row ? answeredDefinition(row) : null,
    document: row ? toDocument(row) : null,
    updated_at: row?.updated_at.toISOString() ?? null,
  };
}

/**
 * The subject's record as the audience may see it: every visible field of the current form, in
 * order, then (leadership only) answers to fields no longer on the form.
 */
export async function getSubjectRecords(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
  audience: RecordAudience,
): Promise<SubjectRecordsDto> {
  await assertSubjectReadable(tx, schoolId, subject, audience);
  const form = await getPublishedForm(tx, schoolId, subject.kind);
  const answers = await loadAnswers(tx, schoolId, subject);
  const byField = new Map(answers.map((row) => [row.field_id, row]));

  const entries: RecordEntryDto[] = form.fields
    .filter((field) => isFieldVisibleTo(field, audience))
    .map((field) =>
      entryFor(toDefinition(field), byField.get(field.id), false, field.field_version_id),
    );

  if (audience === "staff") {
    const onForm = new Set(form.fields.map((field) => field.id));
    const archived = answers
      .filter((row) => !onForm.has(row.field_id))
      .sort((a, b) => a.answered_sort_order - b.answered_sort_order);
    for (const row of archived) {
      if (!hasValue(row) && !hasFile(row)) continue;
      entries.push(entryFor(answeredDefinition(row), row, true, null));
    }
  }

  return {
    subject_kind: subject.kind,
    subject_id: subject.id,
    template_version: form.version,
    entries,
    missing_required: entries.filter((entry) => entry.missing).length,
  };
}

/** The published form for a create screen: leadership only, so every field. */
export async function getRecordForm(tx: TransactionSql, schoolId: string, kind: RecordSubjectKind) {
  const form = await getPublishedForm(tx, schoolId, kind);
  return { subject_kind: kind, version: form.version, fields: form.fields.map(toDefinition) };
}

export interface AnswerInput {
  field_id: string;
  value: RecordValue | null;
}

function valueInvalid(field: PublishedField, error: string): never {
  // Names the field and the rule, never the value: a rejected passport number must not land in
  // logs or Sentry through an error message.
  throw new CodedHttpException(
    422,
    ERROR_CODES.RECORD_VALUE_INVALID,
    `"${field.label_en}": ${error}`,
  );
}

function sealContext(schoolId: string, subject: RecordSubject, fieldId: string) {
  return { schoolId, subjectKind: subject.kind, subjectId: subject.id, fieldId };
}

async function upsertAnswerRow(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
  field: PublishedField,
  actorId: string,
  stored: {
    value: RecordValue | null;
    ciphertext: Uint8Array | null;
    keyId: string | null;
    mask: string | null;
  },
): Promise<{ id: string; inserted: boolean }> {
  const studentId = subject.kind === "student" ? subject.id : null;
  const parentUserId = subject.kind === "parent" ? subject.id : null;
  const [row] = await tx<{ id: string; inserted: boolean }[]>`
    INSERT INTO app.record_answers (
      school_id, subject_kind, student_id, parent_user_id, field_id, field_version_id, value,
      value_ciphertext, value_key_id, value_mask, updated_by
    ) VALUES (
      ${schoolId}::uuid, ${subject.kind}::app.record_subject_kind, ${studentId}::uuid,
      ${parentUserId}::uuid, ${field.id}::uuid, ${field.field_version_id}::uuid,
      ${stored.value === null ? null : tx.json(stored.value as never)}::jsonb,
      ${stored.ciphertext}::bytea, ${stored.keyId}, ${stored.mask}, ${actorId}::uuid
    )
    ON CONFLICT (school_id, subject_kind, subject_id, field_id) DO UPDATE SET
      field_version_id = EXCLUDED.field_version_id,
      value = EXCLUDED.value,
      value_ciphertext = EXCLUDED.value_ciphertext,
      value_key_id = EXCLUDED.value_key_id,
      value_mask = EXCLUDED.value_mask,
      updated_by = EXCLUDED.updated_by,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, (xmax = 0) AS inserted
  `;
  return row!;
}

/**
 * Write answers for one subject, against the current published form. A null value clears an
 * answer. Each change is audited; for a sensitive field the audit row names the field and never
 * carries the value. Missing required fields are never an error: a record is always saveable.
 */
export async function writeAnswers(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
  actorId: string,
  answers: readonly AnswerInput[],
  keyring: RecordKeyring,
): Promise<void> {
  const form = await getPublishedForm(tx, schoolId, subject.kind);
  if (form.version === 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RECORD_TEMPLATE_NOT_PUBLISHED,
      "This school has not published a record template yet",
    );
  }
  const fields = new Map(form.fields.map((field) => [field.id, field]));
  const existing = new Map(
    (await loadAnswers(tx, schoolId, subject)).map((row) => [row.field_id, row]),
  );

  for (const answer of answers) {
    const field = fields.get(answer.field_id);
    if (!field) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RECORD_FIELD_NOT_FOUND,
        "Field is not on the published form",
      );
    }
    if (field.field_type === "document") {
      valueInvalid(field, "a document field takes an uploaded file, not a value");
    }
    const normalized = normalizeRecordValue(field, answer.value);
    if (!normalized.ok) valueInvalid(field, normalized.error);

    const previous = existing.get(field.id);
    const sensitive = field.sensitivity === "sensitive";

    if (normalized.value === null) {
      if (!previous) continue;
      await tx`
        DELETE FROM app.record_answers WHERE school_id = ${schoolId}::uuid AND id = ${previous.id}::uuid
      `;
      await emitAuditLog(tx, {
        action: "delete",
        targetTable: "record_answers",
        targetId: previous.id,
        oldValues: sensitive
          ? { field_id: field.id, sensitive: true }
          : { field_id: field.id, value: previous.value },
      });
      continue;
    }

    const stored = sensitive
      ? (() => {
          const seal = sealRecordValue(
            keyring,
            sealContext(schoolId, subject, field.id),
            field.field_type,
            normalized.value,
          );
          return { value: null, ciphertext: seal.ciphertext, keyId: seal.keyId, mask: seal.mask };
        })()
      : { value: normalized.value, ciphertext: null, keyId: null, mask: null };

    const row = await upsertAnswerRow(tx, schoolId, subject, field, actorId, stored);
    await emitAuditLog(tx, {
      action: row.inserted ? "insert" : "update",
      targetTable: "record_answers",
      targetId: row.id,
      ...(sensitive
        ? {
            oldValues: row.inserted ? null : { field_id: field.id, sensitive: true },
            newValues: { field_id: field.id, sensitive: true, changed: true },
          }
        : {
            oldValues: previous ? { field_id: field.id, value: previous.value } : null,
            newValues: { field_id: field.id, value: normalized.value },
          }),
    });
  }
}

/**
 * The full value of one sensitive answer. Leadership only (studentRecord:readSensitive, checked by
 * the route); audited as a read of the answer: who (the audit row's actor), when, which field --
 * never the value.
 */
export async function revealValue(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
  fieldId: string,
  keyring: RecordKeyring,
): Promise<{ field_id: string; value: RecordValue | null }> {
  await assertSubjectReadable(tx, schoolId, subject, "staff");
  const answers = await loadAnswers(tx, schoolId, subject);
  const row = answers.find((answer) => answer.field_id === fieldId);
  const form = await getPublishedForm(tx, schoolId, subject.kind);
  const field = form.fields.find((candidate) => candidate.id === fieldId);
  const sensitive = field?.sensitivity === "sensitive" || row?.value_ciphertext != null;
  if (!field && !row) {
    throw new CodedHttpException(404, ERROR_CODES.RECORD_FIELD_NOT_FOUND, "Field not found");
  }
  if (!sensitive) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RECORD_FIELD_NOT_SENSITIVE,
      "Only a sensitive field is revealed; this one is returned in full by the record read",
    );
  }

  await emitAuditLog(tx, {
    action: "read",
    targetTable: row ? "record_answers" : "record_fields",
    targetId: row?.id ?? fieldId,
    newValues: {
      field_id: fieldId,
      subject_kind: subject.kind,
      subject_id: subject.id,
      reveal: true,
    },
  });
  if (!row || row.value_ciphertext === null) return { field_id: fieldId, value: null };

  try {
    const opened = openRecordValue(keyring, sealContext(schoolId, subject, fieldId), {
      ciphertext: row.value_ciphertext,
      keyId: row.value_key_id!,
      mask: row.value_mask!,
    });
    return { field_id: fieldId, value: opened.unwrap() };
  } catch (error) {
    if (error instanceof RecordKeyUnavailableError || error instanceof RecordSealBrokenError) {
      throw new CodedHttpException(
        503,
        ERROR_CODES.RECORD_KEY_UNAVAILABLE,
        "This value cannot be opened with the configured keys",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function documentField(form: { fields: PublishedField[] }, fieldId: string): PublishedField {
  const field = form.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.RECORD_FIELD_NOT_FOUND,
      "Field is not on the published form",
    );
  }
  if (field.field_type !== "document") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RECORD_FIELD_NOT_DOCUMENT,
      "This field does not take a document",
    );
  }
  return field;
}

function assertExpiryAllowed(field: PublishedField, expiresOn: string | null | undefined): void {
  if (expiresOn != null && !field.has_expiry) {
    throw new CodedHttpException(
      422,
      ERROR_CODES.RECORD_FIELD_INVALID,
      "This document field has no expiry date",
    );
  }
}

/**
 * Attach (or replace) the file behind a document field. The upload was staged through the generic
 * gateway under the field's content class; it is inspected, quota-checked and promoted here, in
 * the same transaction as the row that references it (the messaging pattern). A sensitive field's
 * file is promoted under the sensitive-documents KMS key (ADR-019). Returns a replaced file's key
 * for the caller to delete once the transaction commits.
 */
export async function attachDocument(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  subject: RecordSubject,
  fieldId: string,
  actorId: string,
  input: { storage_key: string; checksum_sha256?: string; expires_on?: string | null },
): Promise<{ replacedKey: string | null }> {
  await assertSubjectReadable(tx, schoolId, subject, "staff");
  const form = await getPublishedForm(tx, schoolId, subject.kind);
  const field = documentField(form, fieldId);
  assertExpiryAllowed(field, input.expires_on);
  const sensitive = field.sensitivity === "sensitive";
  const contentClass = getContentClass(
    sensitive ? RECORD_SENSITIVE_DOCUMENT_CONTENT_CLASS : RECORD_DOCUMENT_CONTENT_CLASS,
  );

  const upload = await inspectStagedUpload(storage, schoolId, contentClass, {
    storageKey: input.storage_key,
    checksumSha256: input.checksum_sha256,
  });
  await assertStorageUploadQuota(tx, upload.sizeBytes);

  const answer = await upsertAnswerRow(tx, schoolId, subject, field, actorId, {
    value: null,
    ciphertext: null,
    keyId: null,
    mask: null,
  });
  const [previous] = await tx<
    { storage_key: string | null; size_bytes: string | null; status: RecordDocumentStatus }[]
  >`
    SELECT storage_key, size_bytes::text AS size_bytes, status FROM app.record_documents
    WHERE school_id = ${schoolId}::uuid AND answer_id = ${answer.id}::uuid
    FOR UPDATE
  `;

  const permanentKey = buildPermanentKey(schoolId, upload.parsed.objectId, upload.parsed.filename);
  const promoted = await promoteTempObject(storage, input.storage_key, permanentKey, { sensitive });
  await recordStorageUpload(tx, promoted.sizeBytes);
  if (previous?.size_bytes) await releaseStorageUsage(tx, Number(previous.size_bytes));

  const [document] = await tx<{ id: string }[]>`
    INSERT INTO app.record_documents (
      school_id, answer_id, status, storage_key, original_file_name, mime_type, size_bytes,
      sensitive, uploaded_by, uploaded_at, expires_on
    ) VALUES (
      ${schoolId}::uuid, ${answer.id}::uuid, 'uploaded', ${permanentKey}, ${upload.parsed.filename},
      ${upload.contentType}, ${promoted.sizeBytes}, ${sensitive}, ${actorId}::uuid,
      CURRENT_TIMESTAMP, ${input.expires_on ?? null}::date
    )
    ON CONFLICT (school_id, answer_id) DO UPDATE SET
      status = 'uploaded',
      storage_key = EXCLUDED.storage_key,
      original_file_name = EXCLUDED.original_file_name,
      mime_type = EXCLUDED.mime_type,
      size_bytes = EXCLUDED.size_bytes,
      sensitive = EXCLUDED.sensitive,
      uploaded_by = EXCLUDED.uploaded_by,
      uploaded_at = EXCLUDED.uploaded_at,
      verified_by = NULL,
      verified_at = NULL,
      expires_on = coalesce(EXCLUDED.expires_on, app.record_documents.expires_on),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `;

  await emitAuditLog(tx, {
    action: previous ? "update" : "insert",
    targetTable: "record_documents",
    targetId: document!.id,
    oldValues: previous ? { field_id: field.id, status: previous.status, sensitive } : null,
    // The file name of a sensitive document can itself say too much ("passport_A1234567.pdf").
    newValues: {
      field_id: field.id,
      status: "uploaded",
      sensitive,
      ...(sensitive ? {} : { file_name: upload.parsed.filename }),
      content_type: upload.contentType,
      size_bytes: promoted.sizeBytes,
      expires_on: input.expires_on ?? null,
    },
  });
  return { replacedKey: previous?.storage_key ?? null };
}

async function loadDocument(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
  fieldId: string,
) {
  const [row] = await tx<
    {
      id: string;
      status: RecordDocumentStatus;
      storage_key: string | null;
      size_bytes: string | null;
      sensitive: boolean;
      expires_on: string | null;
    }[]
  >`
    SELECT d.id, d.status, d.storage_key, d.size_bytes::text AS size_bytes, d.sensitive,
           to_char(d.expires_on, 'YYYY-MM-DD') AS expires_on
    FROM app.record_documents AS d
    JOIN app.record_answers AS a ON a.id = d.answer_id AND a.school_id = d.school_id
    WHERE d.school_id = ${schoolId}::uuid
      AND a.subject_kind = ${subject.kind}::app.record_subject_kind
      AND a.${tx(subjectColumn(subject))} = ${subject.id}::uuid
      AND a.field_id = ${fieldId}::uuid
    FOR UPDATE OF d
  `;
  if (!row || row.status === "missing") {
    throw new CodedHttpException(404, ERROR_CODES.RECORD_DOCUMENT_NOT_FOUND, "No document on file");
  }
  return row;
}

/** Verify a document, withdraw a verification, or set its expiry date. */
export async function updateDocument(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
  fieldId: string,
  actorId: string,
  input: { status?: "uploaded" | "verified"; expires_on?: string | null },
): Promise<void> {
  await assertSubjectReadable(tx, schoolId, subject, "staff");
  const form = await getPublishedForm(tx, schoolId, subject.kind);
  const field = documentField(form, fieldId);
  assertExpiryAllowed(field, input.expires_on);
  const document = await loadDocument(tx, schoolId, subject, fieldId);

  const status = input.status ?? document.status;
  const expiresOn = input.expires_on === undefined ? document.expires_on : input.expires_on;
  // Verifying stamps who and when; withdrawing clears them; re-saving a verified document's
  // expiry keeps the original verification.
  const verification =
    status === "uploaded" ? "clear" : document.status !== "verified" ? "stamp" : "keep";
  await tx`
    UPDATE app.record_documents SET
      status = ${status}::app.record_document_status,
      verified_by = CASE ${verification}
        WHEN 'stamp' THEN ${actorId}::uuid WHEN 'clear' THEN NULL ELSE verified_by END,
      verified_at = CASE ${verification}
        WHEN 'stamp' THEN CURRENT_TIMESTAMP WHEN 'clear' THEN NULL ELSE verified_at END,
      expires_on = ${expiresOn}::date,
      updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ${document.id}::uuid
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "record_documents",
    targetId: document.id,
    oldValues: { field_id: fieldId, status: document.status, expires_on: document.expires_on },
    newValues: { field_id: fieldId, status, expires_on: expiresOn },
  });
}

/** Remove the file behind a document field. Returns its key to delete once the tx commits. */
export async function removeDocument(
  tx: TransactionSql,
  schoolId: string,
  subject: RecordSubject,
  fieldId: string,
): Promise<{ removedKey: string | null }> {
  await assertSubjectReadable(tx, schoolId, subject, "staff");
  const document = await loadDocument(tx, schoolId, subject, fieldId);
  await tx`
    UPDATE app.record_documents SET
      status = 'missing', storage_key = NULL, original_file_name = NULL, mime_type = NULL,
      size_bytes = NULL, uploaded_by = NULL, uploaded_at = NULL, verified_by = NULL,
      verified_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ${document.id}::uuid
  `;
  if (document.size_bytes) await releaseStorageUsage(tx, Number(document.size_bytes));
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "record_documents",
    targetId: document.id,
    oldValues: { field_id: fieldId, status: document.status, sensitive: document.sensitive },
  });
  return { removedKey: document.storage_key };
}

/**
 * A download URL for the file behind a document field the audience may see. A sensitive document
 * is a sensitive value: it needs studentRecord:readSensitive, its URL lives a minute, and issuing
 * it is audited like a reveal.
 */
export async function documentDownload(
  tx: TransactionSql,
  storage: StorageService,
  schoolId: string,
  subject: RecordSubject,
  fieldId: string,
  audience: RecordAudience,
  canReadSensitive: boolean,
): Promise<{ url: string; expires_at: string }> {
  await assertSubjectReadable(tx, schoolId, subject, audience);
  const form = await getPublishedForm(tx, schoolId, subject.kind);
  const field = form.fields.find((candidate) => candidate.id === fieldId);
  const answers = await loadAnswers(tx, schoolId, subject);
  const row = answers.find((answer) => answer.field_id === fieldId);
  // A field no longer on the form is leadership's to see, as in getSubjectRecords.
  const visible = field ? isFieldVisibleTo(field, audience) : audience === "staff";
  if (!visible || !row || !hasFile(row) || !row.document_storage_key) {
    throw new CodedHttpException(404, ERROR_CODES.RECORD_DOCUMENT_NOT_FOUND, "No document on file");
  }

  const sensitive = row.document_sensitive === true;
  if (sensitive && !canReadSensitive) {
    throw new CodedHttpException(403, ERROR_CODES.AUTHZ_FORBIDDEN, "Insufficient permissions");
  }
  if (sensitive) {
    await emitAuditLog(tx, {
      action: "read",
      targetTable: "record_documents",
      targetId: row.id,
      newValues: { field_id: fieldId, subject_kind: subject.kind, reveal: true, download: true },
    });
  }
  const ttl = sensitive
    ? RECORD_SENSITIVE_DOCUMENT_DOWNLOAD_TTL_SECONDS
    : RECORD_DOCUMENT_DOWNLOAD_TTL_SECONDS;
  const presigned = await storage.presign(row.document_storage_key, "GET", undefined, ttl);
  return { url: presigned.url, expires_at: presigned.expiresAt.toISOString() };
}
