import { Checkbox, Input, Select } from "@studafy/ui";
import { useId } from "react";

import { useTranslation } from "../../lib/i18n";

import { fieldHelp, fieldLabel, isArabic } from "./fields";

import type { RecordDraft } from "./fields";
import type { RecordFieldDefinition } from "./queries";

const INPUT_TYPES: Partial<Record<RecordFieldDefinition["field_type"], string>> = {
  short_text: "text",
  number: "number",
  date: "date",
  phone: "tel",
  email: "email",
};

export interface RecordFieldInputProps {
  field: RecordFieldDefinition;
  value: RecordDraft;
  onChange: (value: RecordDraft) => void;
  /** Shown under the field, e.g. "leave blank to keep the current value" for a sensitive one. */
  hint?: string;
  error?: string;
}

/**
 * One school-defined field as an input, labelled in the active language. Document fields have no
 * input here: their files are uploaded from the record itself (RecordsPanel).
 */
export function RecordFieldInput({ field, value, onChange, hint, error }: RecordFieldInputProps) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const label = fieldLabel(field, language);
  const helperText = [fieldHelp(field, language), hint].filter(Boolean).join(" ") || undefined;
  const textareaId = useId();
  const optionText = (option: RecordFieldDefinition["options"][number]) =>
    isArabic(language) ? option.label_ar : option.label_en;

  switch (field.field_type) {
    case "document":
      return null;
    case "long_text":
      // `sf-field`/`sf-input` chrome around a bare <textarea>: @studafy/ui has no Textarea
      // primitive (the same workaround principal/evaluations uses).
      return (
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={textareaId}>
            {label}
          </label>
          <div className="sf-input records-textarea">
            <textarea
              id={textareaId}
              className="sf-input__control"
              rows={3}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
          {helperText ? <p className="sf-field__helper">{helperText}</p> : null}
          {error ? <p className="sf-field__error">{error}</p> : null}
        </div>
      );
    case "single_choice":
      return (
        <Select
          label={label}
          placeholder={t("records.panel.choose")}
          options={[
            { value: "", label: t("records.panel.unset") },
            ...field.options.map((option) => ({ value: option.value, label: optionText(option) })),
          ]}
          value={typeof value === "string" ? value : ""}
          onChange={(next) => onChange(next === "" ? null : next)}
          helperText={helperText}
          error={error}
        />
      );
    case "yes_no":
      return (
        <Select
          label={label}
          options={[
            { value: "", label: t("records.panel.unset") },
            { value: "yes", label: t("records.panel.yes") },
            { value: "no", label: t("records.panel.no") },
          ]}
          value={value === true ? "yes" : value === false ? "no" : ""}
          onChange={(next) => onChange(next === "yes" ? true : next === "no" ? false : null)}
          helperText={helperText}
          error={error}
        />
      );
    case "multi_choice": {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <fieldset className="records-choices">
          <legend className="sf-field__label">{label}</legend>
          {field.options.map((option) => (
            <Checkbox
              key={option.value}
              label={optionText(option)}
              checked={chosen.includes(option.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...chosen, option.value]
                    : chosen.filter((item) => item !== option.value),
                )
              }
            />
          ))}
          {helperText ? <p className="sf-field__helper">{helperText}</p> : null}
          {error ? <p className="sf-field__error">{error}</p> : null}
        </fieldset>
      );
    }
    default:
      return (
        <Input
          label={label}
          type={INPUT_TYPES[field.field_type] ?? "text"}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          helperText={helperText}
          error={error}
          autoComplete="off"
        />
      );
  }
}
