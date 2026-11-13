import { useEffect, useId, useState } from "react";

import { directionFor, prepareLocale, useTranslation } from "../../../lib/i18n";

import type { RecordTemplateField } from "./queries";
import type { Locale } from "../../../lib/i18n";

export interface FormPreviewProps {
  fields: readonly RecordTemplateField[];
  language: Locale;
}

/**
 * The draft form as staff will see it in one language, without switching the app's language: the
 * school's own labels in that language, and this preview's few words of chrome through a fixed-
 * language translator. Every control is disabled; nothing here is ever submitted.
 */
export function FormPreview({ fields, language }: FormPreviewProps) {
  const { i18n } = useTranslation();
  const [, setLoaded] = useState(0);

  // The other language's catalogs are loaded on demand (prepareLocale), without changing language.
  useEffect(() => {
    let cancelled = false;
    void prepareLocale(language).then(() => {
      if (!cancelled) setLoaded((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const t = i18n.getFixedT(language);
  const label = (field: RecordTemplateField) =>
    language === "ar" ? field.label_ar : field.label_en;
  const help = (field: RecordTemplateField) => (language === "ar" ? field.help_ar : field.help_en);

  return (
    <div className="record-templates__preview" lang={language} dir={directionFor(language)}>
      {fields.length === 0 ? (
        <p className="record-templates__muted">{t("recordTemplates.preview.empty")}</p>
      ) : (
        <fieldset disabled className="record-templates__preview-form">
          <legend className="record-templates__muted">{t("recordTemplates.preview.notice")}</legend>
          {fields.map((field) => (
            <PreviewField
              key={field.id}
              field={field}
              label={label(field)}
              help={help(field)}
              language={language}
              t={t}
            />
          ))}
        </fieldset>
      )}
    </div>
  );
}

interface PreviewFieldProps {
  field: RecordTemplateField;
  label: string;
  help: string | null;
  language: Locale;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function PreviewField({ field, label, help, language, t }: PreviewFieldProps) {
  const id = useId();
  const optionLabel = (option: RecordTemplateField["options"][number]) =>
    language === "ar" ? option.label_ar : option.label_en;

  const heading = (
    <>
      {label}
      {field.required ? (
        <span className="record-templates__required">
          {" "}
          ({t("recordTemplates.preview.required")})
        </span>
      ) : null}
      {field.sensitivity === "sensitive" ? (
        <span className="record-templates__badge" data-tone="warning">
          {t("recordTemplates.badges.sensitive")}
        </span>
      ) : null}
    </>
  );

  let control;
  switch (field.field_type) {
    case "long_text":
      control = <textarea id={id} className="sf-input__control" rows={3} />;
      break;
    case "single_choice":
      control = (
        <select id={id} className="sf-input__control">
          <option>{t("recordTemplates.preview.choose")}</option>
          {field.options.map((option) => (
            <option key={option.value}>{optionLabel(option)}</option>
          ))}
        </select>
      );
      break;
    case "multi_choice":
    case "yes_no": {
      const choices =
        field.field_type === "yes_no"
          ? [t("recordTemplates.preview.yes"), t("recordTemplates.preview.no")]
          : field.options.map(optionLabel);
      return (
        <fieldset className="record-templates__preview-field">
          <legend>{heading}</legend>
          {choices.map((choice) => (
            <label key={choice} className="record-templates__preview-choice">
              <input type={field.field_type === "yes_no" ? "radio" : "checkbox"} name={id} />{" "}
              {choice}
            </label>
          ))}
          {help ? <p className="record-templates__muted">{help}</p> : null}
        </fieldset>
      );
    }
    case "document":
      control = (
        <>
          <input id={id} type="file" />
          {field.has_expiry ? (
            <span className="record-templates__muted">{t("recordTemplates.preview.expiry")}</span>
          ) : null}
        </>
      );
      break;
    default: {
      const type =
        field.field_type === "number"
          ? "number"
          : field.field_type === "date"
            ? "date"
            : field.field_type === "phone"
              ? "tel"
              : field.field_type === "email"
                ? "email"
                : "text";
      control = <input id={id} type={type} className="sf-input__control" />;
    }
  }

  return (
    <div className="record-templates__preview-field">
      <label htmlFor={id}>{heading}</label>
      {control}
      {help ? <p className="record-templates__muted">{help}</p> : null}
    </div>
  );
}
