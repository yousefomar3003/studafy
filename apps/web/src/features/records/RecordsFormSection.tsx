import { Button } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { useTranslation } from "../../lib/i18n";

import { valueFromDraft } from "./fields";
import { fetchRecordForm, recordFormQueryKey } from "./queries";
import { RecordFieldInput } from "./RecordFieldInput";

import "./records.css";

import type { RecordDraft } from "./fields";
import type { RecordAnswerInput, RecordFieldDefinition, RecordSubjectKind } from "./queries";

export type RecordDrafts = Record<string, RecordDraft>;

/** The answers to send with a create request: every field given a value, nothing else. */
export function answersFromDrafts(
  fields: readonly RecordFieldDefinition[],
  drafts: RecordDrafts,
): RecordAnswerInput[] {
  const answers: RecordAnswerInput[] = [];
  for (const field of fields) {
    const value = valueFromDraft(field, drafts[field.id] ?? null);
    if (value !== null) answers.push({ field_id: field.id, value });
  }
  return answers;
}

export interface RecordsFormSectionProps {
  kind: RecordSubjectKind;
  drafts: RecordDrafts;
  onChange: (drafts: RecordDrafts, fields: RecordFieldDefinition[]) => void;
}

/**
 * The optional "Records" step of a create modal: the school's published form for a student or a
 * parent, collapsed until opened. Document fields are left out (files are uploaded on the Records
 * tab once the account exists). Renders nothing when the school has no published fields, so a
 * caller only mounts it when they hold `studentRecord:update`.
 */
export function RecordsFormSection({ kind, drafts, onChange }: RecordsFormSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const form = useQuery({
    queryKey: recordFormQueryKey(kind),
    queryFn: () => fetchRecordForm(kind),
  });

  if (form.isPending || form.isError) return null;
  const fields = (form.data.fields as RecordFieldDefinition[]).filter(
    (field) => field.field_type !== "document",
  );
  if (fields.length === 0) return null;

  return (
    <section className="records-form-section">
      <Button
        type="button"
        variant="tertiary"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        {t("records.form.toggle")}
      </Button>
      <div
        id={regionId}
        role="group"
        aria-label={t("records.form.toggle")}
        hidden={!open}
        className="records-form"
      >
        <p className="records-panel__meta">{t("records.form.hint")}</p>
        {open
          ? fields.map((field) => (
              <RecordFieldInput
                key={field.id}
                field={field}
                value={drafts[field.id] ?? (field.field_type === "multi_choice" ? [] : null)}
                onChange={(value) => onChange({ ...drafts, [field.id]: value }, fields)}
              />
            ))
          : null}
      </div>
    </section>
  );
}
