import { Button, Card, Input, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  assignColumn,
  FIELD_HINTS,
  FIELD_LABELS,
  isSameMapping,
  joinLabels,
  mappingFitsHeaders,
  matchConfidence,
  missingRequiredFields,
  parentPairWarning,
  REQUIRED_STUDENT_IMPORT_FIELDS,
  STUDENT_IMPORT_FIELDS,
} from "./columnMapping";
import { fetchStudentImportMappings, STUDENT_IMPORT_MAPPINGS_KEY } from "./queries";

import type { ColumnMapping, MatchConfidence, StudentImportField } from "./columnMapping";
import type { StudentImport } from "./queries";

const NOT_MAPPED = "";

const CONFIDENCE_LABELS: Readonly<Record<MatchConfidence, string>> = {
  exact: "High: same name",
  alias: "High: known alternative name",
  partial: "Low: partial name, please check",
  manual: "Chosen manually",
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
  const [saveAs, setSaveAs] = useState("");

  const savedMappingsQuery = useQuery({
    queryKey: STUDENT_IMPORT_MAPPINGS_KEY,
    queryFn: fetchStudentImportMappings,
  });
  const savedMappings = savedMappingsQuery.data ?? [];

  const headers = record.source_headers;
  const missing = missingRequiredFields(draft);
  const mappedRequired = REQUIRED_STUDENT_IMPORT_FIELDS.length - missing.length;
  const dirty = !isSameMapping(draft, record.column_mapping);
  const pairWarning = parentPairWarning(draft);
  const trimmedSaveAs = saveAs.trim();

  function fieldOf(header: string): StudentImportField | undefined {
    return STUDENT_IMPORT_FIELDS.find((field) => draft[field] === header);
  }

  function optionsFor(field: StudentImportField) {
    return [
      { value: NOT_MAPPED, label: "Not mapped" },
      ...headers.map((header) => {
        const owner = fieldOf(header);
        return {
          value: header,
          label: owner && owner !== field ? `${header} (now ${FIELD_LABELS[owner]})` : header,
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
    <Card as="section" aria-label="Column mapping">
      <Card.Body>
        <h2 className="students-import__heading">Match your columns</h2>
        <p>
          {headers.length} column{headers.length === 1 ? "" : "s"} found on line{" "}
          {record.header_line} of {record.file_name}. Check each match, choose a column for anything
          that is missing, then apply the mapping to re-check the file.
        </p>

        {savedMappings.length > 0 ? (
          <div className="students-import__saved-mapping">
            <Select
              label="Use a saved mapping"
              placeholder="Choose a saved mapping"
              helperText="Applies straight away."
              disabled={applying}
              options={savedMappings.map((mapping) => {
                const fits = mappingFitsHeaders(mapping.column_mapping, headers);
                return {
                  value: mapping.id,
                  label: fits ? mapping.name : `${mapping.name} (columns not in this file)`,
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
            aria-label="Required fields mapped"
          />
          <span>
            {mappedRequired} of {REQUIRED_STUDENT_IMPORT_FIELDS.length} required fields mapped
            {missing.length > 0 ? `. Missing: ${joinLabels(missing)}.` : "."}
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
                  label={FIELD_LABELS[field]}
                  required={REQUIRED_STUDENT_IMPORT_FIELDS.includes(field)}
                  helperText={FIELD_HINTS[field]}
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
                    {CONFIDENCE_LABELS[confidence]}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="students-import__apply">
          <Input
            label="Save as (optional)"
            helperText="Name this mapping to reuse it next time."
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
            {dirty ? "Apply mapping" : "Save mapping"}
          </Button>
        </div>
      </Card.Body>
    </Card>
  );
}
