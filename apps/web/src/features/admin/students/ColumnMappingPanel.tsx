import { Button, Card, Input, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import {
  assignColumn,
  assignRecordColumn,
  fieldHint,
  fieldLabel,
  isSameMapping,
  joinLabels,
  mappingFitsHeaders,
  matchConfidence,
  missingRequiredFields,
  parentPairWarning,
  REQUIRED_STUDENT_IMPORT_FIELDS,
  STUDENT_IMPORT_FIELDS,
} from "./columnMapping";
import {
  fetchStudentImportMappings,
  fetchStudentRecordForm,
  STUDENT_IMPORT_MAPPINGS_KEY,
  STUDENT_RECORD_FORM_KEY,
} from "./queries";

import type { ColumnMapping, MatchConfidence, StudentImportField } from "./columnMapping";
import type { StudentImport } from "./queries";

const NOT_MAPPED = "";

const CONFIDENCE_LABEL_KEYS: Readonly<Record<MatchConfidence, string>> = {
  exact: "adminPeople.students.import.confidence.exact",
  alias: "adminPeople.students.import.confidence.alias",
  partial: "adminPeople.students.import.confidence.partial",
  manual: "adminPeople.students.import.confidence.manual",
};

interface ColumnMappingPanelProps {
  record: StudentImport;
  draft: ColumnMapping;
  onDraftChange: (draft: ColumnMapping) => void;
  applying: boolean;
  /** Resolves `true` once the server has re-mapped the import, `false` if it refused. */
  onApply: (mapping: ColumnMapping, saveAs?: string) => Promise<boolean>;
}

/**
 * The mapping step: one dropdown per import field listing the file's own columns, a match
 * confidence for each mapped column, a required-field completeness indicator, and saved mappings.
 *
 * Edits stay in `draft` until applied; applying (`PUT .../mapping`) re-validates the staged rows on
 * the server. Picking a saved mapping applies it immediately, which is the one-click path for a
 * repeat import of the same export.
 */
export function ColumnMappingPanel({
  record,
  draft,
  onDraftChange,
  applying,
  onApply,
}: ColumnMappingPanelProps) {
  const { t, i18n } = useTranslation();
  const [saveAs, setSaveAs] = useState("");
  const arabic = i18n.language.startsWith("ar");

  // The published student record form's fields are importable columns too (a document field is
  // listed, unmappable, so the admin knows where its files go instead).
  const recordFormQuery = useQuery({
    queryKey: STUDENT_RECORD_FORM_KEY,
    queryFn: fetchStudentRecordForm,
  });
  const recordFields = recordFormQuery.data ?? [];

  const savedMappingsQuery = useQuery({
    queryKey: STUDENT_IMPORT_MAPPINGS_KEY,
    queryFn: fetchStudentImportMappings,
  });
  const savedMappings = savedMappingsQuery.data ?? [];

  const headers = record.source_headers;
  const missing = missingRequiredFields(draft);
  const mappedRequired = REQUIRED_STUDENT_IMPORT_FIELDS.length - missing.length;
  const dirty = !isSameMapping(draft, record.column_mapping);
  const pairWarning = parentPairWarning(draft, t);
  const trimmedSaveAs = saveAs.trim();

  function recordLabel(field: { label_en: string; label_ar: string }): string {
    return arabic ? field.label_ar : field.label_en;
  }

  /** Who reads `header` now: a fixed field's label or a template field's, or undefined. */
  function ownerOf(header: string): { key: string; label: string } | undefined {
    const field = STUDENT_IMPORT_FIELDS.find((candidate) => draft[candidate] === header);
    if (field) return { key: field, label: fieldLabel(field, t) };
    const recordId = Object.entries(draft.records ?? {}).find(([, value]) => value === header)?.[0];
    const recordField = recordFields.find((candidate) => candidate.id === recordId);
    return recordField ? { key: recordField.id, label: recordLabel(recordField) } : undefined;
  }

  function optionsFor(key: string) {
    return [
      { value: NOT_MAPPED, label: t("adminPeople.students.import.mapping.notMapped") },
      ...headers.map((header) => {
        const owner = ownerOf(header);
        return {
          value: header,
          label:
            owner && owner.key !== key
              ? t("adminPeople.students.import.mapping.nowMapped", { header, field: owner.label })
              : header,
        };
      }),
    ];
  }

  async function handleApply() {
    // Kept on failure: a taken name is the likeliest refusal, and the admin should only retype it.
    if (await onApply(draft, trimmedSaveAs || undefined)) setSaveAs("");
  }

  function handleSavedMapping(mappingId: string) {
    const saved = savedMappings.find((mapping) => mapping.id === mappingId);
    if (saved) void onApply(saved.column_mapping);
  }

  return (
    <Card as="section" aria-label={t("adminPeople.students.import.mapping.region")}>
      <Card.Body>
        <h2 className="students-import__heading">
          {t("adminPeople.students.import.mapping.heading")}
        </h2>
        <p>
          {t("adminPeople.students.import.mapping.intro", {
            count: headers.length,
            line: record.header_line,
            file: record.file_name,
          })}
        </p>

        {savedMappings.length > 0 ? (
          <div className="students-import__saved-mapping">
            <Select
              label={t("adminPeople.students.import.mapping.savedLabel")}
              placeholder={t("adminPeople.students.import.mapping.savedPlaceholder")}
              helperText={t("adminPeople.students.import.mapping.savedHelper")}
              disabled={applying}
              options={savedMappings.map((mapping) => {
                const fits = mappingFitsHeaders(mapping.column_mapping, headers);
                return {
                  value: mapping.id,
                  label: fits
                    ? mapping.name
                    : t("adminPeople.students.import.mapping.savedUnfit", { name: mapping.name }),
                  disabled: !fits,
                };
              })}
              onChange={handleSavedMapping}
            />
          </div>
        ) : null}

        <div className="students-import__completeness" role="status">
          <progress
            value={mappedRequired}
            max={REQUIRED_STUDENT_IMPORT_FIELDS.length}
            aria-label={t("adminPeople.students.import.mapping.requiredMapped")}
          />
          <span>
            {missing.length > 0
              ? t("adminPeople.students.import.mapping.progressMissing", {
                  mapped: mappedRequired,
                  total: REQUIRED_STUDENT_IMPORT_FIELDS.length,
                  fields: joinLabels(missing, t),
                })
              : t("adminPeople.students.import.mapping.progress", {
                  mapped: mappedRequired,
                  total: REQUIRED_STUDENT_IMPORT_FIELDS.length,
                })}
          </span>
        </div>

        {pairWarning ? <p className="students-import__warning">{pairWarning}</p> : null}

        <ul className="students-import__fields">
          {STUDENT_IMPORT_FIELDS.map((field) => {
            const header = draft[field];
            const confidence = header === undefined ? null : matchConfidence(field, header);
            return (
              <li key={field} className="students-import__field">
                <Select
                  label={fieldLabel(field, t)}
                  required={REQUIRED_STUDENT_IMPORT_FIELDS.includes(field)}
                  helperText={fieldHint(field, t)}
                  options={optionsFor(field)}
                  value={header ?? NOT_MAPPED}
                  disabled={applying}
                  onChange={(value) =>
                    onDraftChange(
                      assignColumn(draft, field, value === NOT_MAPPED ? undefined : value),
                    )
                  }
                />
                {confidence ? (
                  <span className="students-import__confidence" data-confidence={confidence}>
                    {t(CONFIDENCE_LABEL_KEYS[confidence])}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>

        {recordFields.length > 0 ? (
          <section aria-labelledby="students-import-record-fields">
            <h3 id="students-import-record-fields" className="students-import__heading">
              {t("adminPeople.students.import.mapping.recordsHeading")}
            </h3>
            <p>{t("adminPeople.students.import.mapping.recordsIntro")}</p>
            <ul className="students-import__fields">
              {recordFields.map((field) =>
                field.field_type === "document" ? (
                  <li key={field.id} className="students-import__field">
                    <p className="students-import__hint">
                      {t("adminPeople.students.import.mapping.recordDocument", {
                        field: recordLabel(field),
                      })}
                    </p>
                  </li>
                ) : (
                  <li key={field.id} className="students-import__field">
                    <Select
                      label={recordLabel(field)}
                      helperText={
                        field.sensitivity === "sensitive"
                          ? t("adminPeople.students.import.mapping.recordSensitive")
                          : undefined
                      }
                      options={optionsFor(field.id)}
                      value={draft.records?.[field.id] ?? NOT_MAPPED}
                      disabled={applying}
                      onChange={(value) =>
                        onDraftChange(
                          assignRecordColumn(
                            draft,
                            field.id,
                            value === NOT_MAPPED ? undefined : value,
                          ),
                        )
                      }
                    />
                  </li>
                ),
              )}
            </ul>
          </section>
        ) : null}

        <div className="students-import__apply">
          <Input
            label={t("adminPeople.students.import.mapping.saveAs")}
            helperText={t("adminPeople.students.import.mapping.saveAsHelper")}
            value={saveAs}
            maxLength={100}
            onChange={(event) => setSaveAs(event.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            loading={applying}
            disabled={!dirty && !trimmedSaveAs}
            onClick={() => void handleApply()}
          >
            {dirty
              ? t("adminPeople.students.import.mapping.apply")
              : t("adminPeople.students.import.mapping.save")}
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
}
