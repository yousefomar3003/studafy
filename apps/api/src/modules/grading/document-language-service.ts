import { emitAuditLog } from "../../middleware/auditEmitter";

import type { TransactionSql } from "postgres";

/**
 * Arabic + English documents (000264): the language each kind of issued document is rendered in,
 * and the Arabic names copied into a document's content when it is issued.
 *
 * `viewer` (the default) keeps documents as they were: no language is stored, and each reader sees
 * the document in their own language. `en`, `ar` and `bilingual` are copied into the content at
 * issue, so an issued document keeps its language whatever the setting becomes later.
 */

export type DocumentLanguage = "en" | "ar" | "bilingual";
export type DocumentLanguageSetting = "viewer" | DocumentLanguage;
export type DocumentKind = "report_card" | "certificate" | "transcript";

export interface DocumentLanguageSettings {
  report_card_language: DocumentLanguageSetting;
  certificate_language: DocumentLanguageSetting;
  transcript_language: DocumentLanguageSetting;
  /** The school's Arabic name shown on documents; null falls back to its name. */
  school_name_ar: string | null;
}

export interface UpdateDocumentLanguageSettingsInput {
  report_card_language?: DocumentLanguageSetting;
  certificate_language?: DocumentLanguageSetting;
  transcript_language?: DocumentLanguageSetting;
  /** Omitted: unchanged. null or blank: cleared. */
  school_name_ar?: string | null;
}

export async function getDocumentLanguageSettings(
  tx: TransactionSql,
  schoolId: string,
): Promise<DocumentLanguageSettings> {
  const [row] = await tx<
    {
      report_card_language: DocumentLanguageSetting | null;
      certificate_language: DocumentLanguageSetting | null;
      transcript_language: DocumentLanguageSetting | null;
      school_name_ar: string | null;
    }[]
  >`
    SELECT settings.report_card_language, settings.certificate_language,
           settings.transcript_language, school.name_ar AS school_name_ar
    FROM app.schools AS school
    LEFT JOIN app.document_language_settings AS settings ON settings.school_id = school.id
    WHERE school.id = ${schoolId}::uuid
  `;
  return {
    report_card_language: row?.report_card_language ?? "viewer",
    certificate_language: row?.certificate_language ?? "viewer",
    transcript_language: row?.transcript_language ?? "viewer",
    school_name_ar: row?.school_name_ar ?? null,
  };
}

export async function updateDocumentLanguageSettings(
  tx: TransactionSql,
  schoolId: string,
  input: UpdateDocumentLanguageSettingsInput,
): Promise<DocumentLanguageSettings> {
  const before = await getDocumentLanguageSettings(tx, schoolId);
  const next = {
    report_card_language: input.report_card_language ?? before.report_card_language,
    certificate_language: input.certificate_language ?? before.certificate_language,
    transcript_language: input.transcript_language ?? before.transcript_language,
  };
  await tx`
    INSERT INTO app.document_language_settings (
      school_id, report_card_language, certificate_language, transcript_language
    )
    VALUES (
      ${schoolId}::uuid, ${next.report_card_language}, ${next.certificate_language},
      ${next.transcript_language}
    )
    ON CONFLICT (school_id) DO UPDATE SET
      report_card_language = EXCLUDED.report_card_language,
      certificate_language = EXCLUDED.certificate_language,
      transcript_language = EXCLUDED.transcript_language,
      updated_at = GREATEST(CURRENT_TIMESTAMP, app.document_language_settings.created_at)
  `;
  if (input.school_name_ar !== undefined) {
    const nameAr = input.school_name_ar?.trim() || null;
    await tx`
      UPDATE app.schools SET name_ar = ${nameAr}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${schoolId}::uuid
    `;
  }
  const after = await getDocumentLanguageSettings(tx, schoolId);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "document_language_settings",
    targetId: schoolId,
    oldValues: { ...before },
    newValues: { ...after },
  });
  return after;
}

/** The language a document of `kind` is issued in now; null for `viewer` (store none). */
export async function documentLanguageFor(
  tx: TransactionSql,
  schoolId: string,
  kind: DocumentKind,
): Promise<DocumentLanguage | null> {
  const settings = await getDocumentLanguageSettings(tx, schoolId);
  const setting =
    kind === "report_card"
      ? settings.report_card_language
      : kind === "certificate"
        ? settings.certificate_language
        : settings.transcript_language;
  return setting === "viewer" ? null : setting;
}

/** `{ [key]: value }` when the value is a non-blank string, else nothing: an optional addition. */
export function optionalText<K extends string>(
  key: K,
  value: string | null | undefined,
): Partial<Record<K, string>> {
  return value && value.trim() !== "" ? ({ [key]: value } as Record<K, string>) : {};
}

/** A student's Arabic names as document additions (absent when the school keeps none). */
export function documentStudentNamesAr(student: {
  first_name_ar: string | null;
  middle_name_ar: string | null;
  last_name_ar: string | null;
}): { first_name_ar?: string; middle_name_ar?: string; last_name_ar?: string } {
  return {
    ...optionalText("first_name_ar", student.first_name_ar),
    ...optionalText("middle_name_ar", student.middle_name_ar),
    ...optionalText("last_name_ar", student.last_name_ar),
  };
}
