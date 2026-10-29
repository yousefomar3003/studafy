import { ApiError } from "@studafy/api-client";
import { Button, Checkbox, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateRecordField, useUpdateRecordField } from "./mutations";
import {
  DEFAULT_RETENTION_MONTHS,
  isChoiceType,
  RECORD_FIELD_TYPES,
  RECORD_FIELD_VISIBILITIES,
} from "./queries";
import { labelSuggestsSensitive } from "./sensitive-hint";

import type {
  RecordFieldOption,
  RecordFieldSensitivity,
  RecordFieldType,
  RecordFieldVisibility,
  RecordSubjectKind,
  RecordTemplateField,
} from "./queries";
import type { FormEvent } from "react";

interface FieldValues {
  field_type: RecordFieldType;
  label_en: string;
  label_ar: string;
  help_en: string;
  help_ar: string;
  required: boolean;
  options: RecordFieldOption[];
  visibility: RecordFieldVisibility;
  sensitivity: RecordFieldSensitivity;
  has_expiry: boolean;
  retention_months: string;
}

type FieldErrors = Partial<
  Record<"label_en" | "label_ar" | "options" | "retention_months", string>
>;

function initialValues(field: RecordTemplateField | null): FieldValues {
  return {
    field_type: field?.field_type ?? "short_text",
    label_en: field?.label_en ?? "",
    label_ar: field?.label_ar ?? "",
    help_en: field?.help_en ?? "",
    help_ar: field?.help_ar ?? "",
    required: field?.required ?? false,
    options: field?.options.map((option) => ({ ...option })) ?? [],
    visibility: field?.visibility ?? "staff_only",
    sensitivity: field?.sensitivity ?? "standard",
    has_expiry: field?.has_expiry ?? false,
    retention_months: field?.retention_months != null ? String(field.retention_months) : "",
  };
}

function validate(values: FieldValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.label_en.trim()) errors.label_en = "recordTemplates.field.errors.labelRequired";
  if (!values.label_ar.trim()) errors.label_ar = "recordTemplates.field.errors.labelRequired";
  if (isChoiceType(values.field_type)) {
    const complete = values.options.every(
      (option) => option.value.trim() && option.label_en.trim() && option.label_ar.trim(),
    );
    const unique = new Set(values.options.map((option) => option.value.trim())).size;
    if (values.options.length === 0)
      errors.options = "recordTemplates.field.errors.optionsRequired";
    else if (!complete) errors.options = "recordTemplates.field.errors.optionIncomplete";
    else if (unique !== values.options.length) {
      errors.options = "recordTemplates.field.errors.optionDuplicate";
    }
  }
  if (values.sensitivity === "sensitive" && values.retention_months.trim()) {
    const months = Number(values.retention_months);
    if (!Number.isInteger(months) || months < 1 || months > 120) {
      errors.retention_months = "recordTemplates.field.errors.retention";
    }
  }
  return errors;
}

export interface FieldEditorModalProps {
  open: boolean;
  kind: RecordSubjectKind;
  /** The field to edit, or null to add one. */
  field: RecordTemplateField | null;
  onClose: () => void;
}

/**
 * Adds or edits one draft field. A published field's type is locked, and a field once published as
 * sensitive stays sensitive (the API answers 409 RECORD_FIELD_LOCKED otherwise), so both controls
 * are disabled with the reason beside them. Marking a field sensitive, or typing a label that reads
 * like an ID number, a passport or medical information, explains what sensitive handling means.
 */
export function FieldEditorModal({ open, kind, field, onClose }: FieldEditorModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createField = useCreateRecordField(kind);
  const updateField = useUpdateRecordField(kind);
  const [values, setValues] = useState<FieldValues>(() => initialValues(field));
  const [errors, setErrors] = useState<FieldErrors>({});

  useEffect(() => {
    if (open) {
      setValues(initialValues(field));
      setErrors({});
    }
  }, [open, field]);

  const typeLocked = field?.published === true;
  const sensitivityLocked = field?.published === true && field.sensitivity === "sensitive";
  const sensitive = values.sensitivity === "sensitive";
  const suggestsSensitive =
    !sensitive &&
    (labelSuggestsSensitive(values.label_en, values.label_ar) ||
      (field?.label_suggests_sensitive === true &&
        values.label_en === field.label_en &&
        values.label_ar === field.label_ar));

  function setField<K extends keyof FieldValues>(key: K, value: FieldValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function setOption(index: number, patch: Partial<RecordFieldOption>) {
    setField(
      "options",
      values.options.map((option, i) => (i === index ? { ...option, ...patch } : option)),
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const definition = {
      label_en: values.label_en.trim(),
      label_ar: values.label_ar.trim(),
      help_en: values.help_en.trim() || null,
      help_ar: values.help_ar.trim() || null,
      required: values.required,
      options: isChoiceType(values.field_type)
        ? values.options.map((option) => ({
            value: option.value.trim(),
            label_en: option.label_en.trim(),
            label_ar: option.label_ar.trim(),
          }))
        : [],
      visibility: values.visibility,
      sensitivity: values.sensitivity,
      has_expiry: values.field_type === "document" ? values.has_expiry : false,
      retention_months:
        sensitive && values.retention_months.trim() ? Number(values.retention_months) : null,
    };
    const callbacks = {
      onSuccess: () => {
        show({
          variant: "success" as const,
          title: t(field ? "recordTemplates.field.updated" : "recordTemplates.field.added"),
        });
        onClose();
      },
      onError: (error: Error) => {
        show({
          variant: "error" as const,
          title: t(
            error instanceof ApiError && error.code === "RECORD_FIELD_LOCKED"
              ? "recordTemplates.field.lockedError"
              : "recordTemplates.field.saveError",
          ),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    };
    if (field) {
      updateField.mutate(
        {
          fieldId: field.id,
          body: typeLocked ? definition : { ...definition, field_type: values.field_type },
        },
        callbacks,
      );
    } else {
      createField.mutate({ ...definition, field_type: values.field_type }, callbacks);
    }
  }

  const title = t(field ? "recordTemplates.field.editTitle" : "recordTemplates.field.addTitle");
  const typeOptions = RECORD_FIELD_TYPES.map((type) => ({
    value: type,
    label: t(`recordTemplates.types.${type}`),
  }));
  const visibilityOptions = RECORD_FIELD_VISIBILITIES.map((visibility) => ({
    value: visibility,
    label: t(`recordTemplates.visibility.${visibility}`),
  }));

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={handleSubmit} noValidate aria-label={title}>
        <Modal.Body>
          <Select
            label={t("recordTemplates.field.type")}
            options={typeOptions}
            value={values.field_type}
            onChange={(value) => setField("field_type", value)}
            disabled={typeLocked}
            helperText={typeLocked ? t("recordTemplates.field.typeLocked") : undefined}
          />
          <Input
            label={t("recordTemplates.field.labelEn")}
            value={values.label_en}
            onChange={(event) => setField("label_en", event.target.value)}
            error={errors.label_en && t(errors.label_en)}
            maxLength={200}
            required
          />
          <Input
            label={t("recordTemplates.field.labelAr")}
            value={values.label_ar}
            onChange={(event) => setField("label_ar", event.target.value)}
            error={errors.label_ar && t(errors.label_ar)}
            maxLength={200}
            dir="rtl"
            lang="ar"
            required
          />
          <Input
            label={t("recordTemplates.field.helpEn")}
            value={values.help_en}
            onChange={(event) => setField("help_en", event.target.value)}
            maxLength={1000}
          />
          <Input
            label={t("recordTemplates.field.helpAr")}
            value={values.help_ar}
            onChange={(event) => setField("help_ar", event.target.value)}
            maxLength={1000}
            dir="rtl"
            lang="ar"
          />

          {isChoiceType(values.field_type) ? (
            <fieldset className="record-templates__options">
              <legend>{t("recordTemplates.field.options")}</legend>
              {values.options.map((option, index) => (
                <div className="record-templates__option" key={index}>
                  <Input
                    label={t("recordTemplates.field.optionValue", { number: index + 1 })}
                    value={option.value}
                    onChange={(event) => setOption(index, { value: event.target.value })}
                    maxLength={100}
                  />
                  <Input
                    label={t("recordTemplates.field.optionLabelEn", { number: index + 1 })}
                    value={option.label_en}
                    onChange={(event) => setOption(index, { label_en: event.target.value })}
                    maxLength={200}
                  />
                  <Input
                    label={t("recordTemplates.field.optionLabelAr", { number: index + 1 })}
                    value={option.label_ar}
                    onChange={(event) => setOption(index, { label_ar: event.target.value })}
                    maxLength={200}
                    dir="rtl"
                    lang="ar"
                  />
                  <Button
                    type="button"
                    variant="tertiary"
                    onClick={() =>
                      setField(
                        "options",
                        values.options.filter((_, i) => i !== index),
                      )
                    }
                  >
                    {t("recordTemplates.field.removeOption", { number: index + 1 })}
                  </Button>
                </div>
              ))}
              {errors.options ? (
                <p className="record-templates__error" role="alert">
                  {t(errors.options)}
                </p>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  setField("options", [
                    ...values.options,
                    { value: "", label_en: "", label_ar: "" },
                  ])
                }
              >
                {t("recordTemplates.field.addOption")}
              </Button>
            </fieldset>
          ) : null}

          <Checkbox
            label={t("recordTemplates.field.required")}
            checked={values.required}
            onChange={(event) => setField("required", event.target.checked)}
          />
          {values.field_type === "document" ? (
            <Checkbox
              label={t("recordTemplates.field.hasExpiry")}
              checked={values.has_expiry}
              onChange={(event) => setField("has_expiry", event.target.checked)}
            />
          ) : null}
          <Select
            label={t("recordTemplates.field.visibility")}
            options={visibilityOptions}
            value={values.visibility}
            onChange={(value) => setField("visibility", value)}
            helperText={t("recordTemplates.field.visibilityHelp")}
          />
          <Checkbox
            label={t("recordTemplates.field.sensitive")}
            checked={sensitive}
            disabled={sensitivityLocked}
            onChange={(event) =>
              setField("sensitivity", event.target.checked ? "sensitive" : "standard")
            }
          />
          {sensitivityLocked ? (
            <p className="record-templates__muted">
              {t("recordTemplates.field.sensitivityLocked")}
            </p>
          ) : null}

          {suggestsSensitive ? (
            <div className="record-templates__note" role="note" data-tone="warning">
              <p>{t("recordTemplates.sensitive.hint")}</p>
              <SensitiveExplanation />
              <Button
                type="button"
                variant="secondary"
                onClick={() => setField("sensitivity", "sensitive")}
              >
                {t("recordTemplates.sensitive.markSensitive")}
              </Button>
            </div>
          ) : null}

          {sensitive ? (
            <div className="record-templates__note" role="note">
              <p>{t("recordTemplates.sensitive.title")}</p>
              <SensitiveExplanation />
              <Input
                label={t("recordTemplates.field.retention")}
                type="number"
                min={1}
                max={120}
                value={values.retention_months}
                placeholder={String(DEFAULT_RETENTION_MONTHS)}
                onChange={(event) => setField("retention_months", event.target.value)}
                error={errors.retention_months && t(errors.retention_months)}
                helperText={t("recordTemplates.field.retentionHelp", {
                  count: DEFAULT_RETENTION_MONTHS,
                })}
              />
            </div>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("recordTemplates.common.cancel")}
          </Button>
          <Button type="submit" loading={createField.isPending || updateField.isPending}>
            {t(field ? "recordTemplates.field.save" : "recordTemplates.field.add")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

/** What "sensitive" commits the school to: the same four facts wherever it is explained. */
export function SensitiveExplanation() {
  const { t } = useTranslation();
  return (
    <ul className="record-templates__explain">
      <li>{t("recordTemplates.sensitive.masked")}</li>
      <li>{t("recordTemplates.sensitive.permission")}</li>
      <li>{t("recordTemplates.sensitive.logged")}</li>
      <li>{t("recordTemplates.sensitive.retention", { count: DEFAULT_RETENTION_MONTHS })}</li>
    </ul>
  );
}
