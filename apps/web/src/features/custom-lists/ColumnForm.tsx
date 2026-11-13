import { Checkbox, Input, Select } from "@studafy/ui";
import { useId } from "react";

import { useTranslation } from "../../lib/i18n";

import { COLUMN_TYPES } from "./queries";

import type { ColumnFieldType } from "./queries";
import type { components } from "@studafy/api-client";

type FieldOption = components["schemas"]["RecordFieldOption"];

export interface ColumnDraft {
  label_en: string;
  label_ar: string;
  field_type: ColumnFieldType;
  required: boolean;
  sensitive: boolean;
  /** One choice per line, "English | العربية" (the Arabic label defaults to the English one). */
  options: string;
}

export const EMPTY_COLUMN: ColumnDraft = {
  label_en: "",
  label_ar: "",
  field_type: "short_text",
  required: false,
  sensitive: false,
  options: "",
};

export function isChoice(type: ColumnFieldType): boolean {
  return type === "single_choice" || type === "multi_choice";
}

/** The choices a draft's text names, each value being its English label. */
export function parseOptions(text: string): FieldOption[] {
  const seen = new Set<string>();
  const options: FieldOption[] = [];
  for (const line of text.split("\n")) {
    const [english = "", arabic = ""] = line.split("|").map((part) => part.trim());
    if (!english || seen.has(english)) continue;
    seen.add(english);
    options.push({ value: english, label_en: english, label_ar: arabic || english });
  }
  return options;
}

export function optionsText(options: readonly FieldOption[]): string {
  return options
    .map((option) =>
      option.label_ar === option.label_en
        ? option.label_en
        : `${option.label_en} | ${option.label_ar}`,
    )
    .join("\n");
}

/** The draft as the API takes a new column, or null while it is incomplete. */
export function columnBody(draft: ColumnDraft) {
  const label_en = draft.label_en.trim();
  const label_ar = draft.label_ar.trim() || label_en;
  if (!label_en) return null;
  const options = isChoice(draft.field_type) ? parseOptions(draft.options) : [];
  if (isChoice(draft.field_type) && options.length === 0) return null;
  return {
    field_type: draft.field_type,
    label_en,
    label_ar,
    required: draft.required,
    sensitivity: draft.sensitive ? ("sensitive" as const) : ("standard" as const),
    options,
  };
}

export interface ColumnFormProps {
  draft: ColumnDraft;
  onChange: (draft: ColumnDraft) => void;
  /** Type and sensitivity are fixed once a column exists. */
  locked?: boolean;
}

/** A column's labels, type, required flag, sensitivity and choices. */
export function ColumnForm({ draft, onChange, locked = false }: ColumnFormProps) {
  const { t } = useTranslation();
  const optionsId = useId();
  const set = (patch: Partial<ColumnDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="custom-lists__column-form">
      <Input
        label={t("customLists.column.labelEn")}
        value={draft.label_en}
        onChange={(event) => set({ label_en: event.target.value })}
        required
      />
      <Input
        label={t("customLists.column.labelAr")}
        value={draft.label_ar}
        dir="rtl"
        onChange={(event) => set({ label_ar: event.target.value })}
      />
      <Select
        label={t("customLists.column.type")}
        options={COLUMN_TYPES.map((type) => ({
          value: type,
          label: t(`customLists.types.${type}`),
        }))}
        value={draft.field_type}
        onChange={(value) => set({ field_type: value as ColumnFieldType })}
        disabled={locked}
      />
      {isChoice(draft.field_type) ? (
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={optionsId}>
            {t("customLists.column.options")}
          </label>
          <div className="sf-input custom-lists__textarea">
            <textarea
              id={optionsId}
              className="sf-input__control"
              rows={4}
              value={draft.options}
              onChange={(event) => set({ options: event.target.value })}
            />
          </div>
          <p className="sf-field__helper">{t("customLists.column.optionsHelp")}</p>
        </div>
      ) : null}
      <Checkbox
        label={t("customLists.column.required")}
        checked={draft.required}
        onChange={(event) => set({ required: event.target.checked })}
      />
      <Checkbox
        label={t("customLists.column.sensitive")}
        checked={draft.sensitive}
        onChange={(event) => set({ sensitive: event.target.checked })}
        disabled={locked}
      />
      {!locked ? (
        <p className="custom-lists__muted">{t("customLists.column.sensitiveHelp")}</p>
      ) : null}
    </div>
  );
}
