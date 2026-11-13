import { ApiError } from "@studafy/api-client";
import {
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  Radio,
  RadioGroup,
  Select,
} from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../../lib/i18n";

import { useApplyImportColumn, usePreviewImportColumn } from "./mutations";
import { fetchRecordForm, recordFormKey } from "./queries";

import type {
  ImportColumnPreview,
  ImportColumnPreviewRow,
  ImportColumnTarget,
  ParentSlot,
  RecordSubjectKind,
  UnmappedColumn,
} from "./queries";

type FieldType = UnmappedColumn["suggested_field_type"];

/** The types a new field can take from a column. A choice type only when the column's values
 * suggested its choices: the panel does not edit options. */
const PLAIN_TYPES: readonly FieldType[] = [
  "short_text",
  "long_text",
  "number",
  "date",
  "yes_no",
  "phone",
  "email",
];

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.detail ?? error.title) : fallback;
}

interface MapColumnPanelProps {
  importId: string;
  column: UnmappedColumn;
  onClose: () => void;
}

/**
 * Map one unmapped column to a record field and write it, in two explicit steps: Preview shows,
 * person by person, what would be written (a sensitive value as its mask only); Write sends the
 * preview's token back, and the API refuses if anything changed since. Any edit to the choices here
 * discards the preview, so what is confirmed is always what was shown.
 */
export function MapColumnPanel({ importId, column, onClose }: MapColumnPanelProps) {
  const { t } = useTranslation();
  const base = "adminPeople.students.importHistory.map";
  const [subjectKind, setSubjectKind] = useState<RecordSubjectKind>("student");
  // Whose parent record: the file's first parent, its second, or both. Never assumed when the import
  // created second parents -- a "father" column must not land on the mother because she is listed
  // first -- so with any second parent the choice starts empty and must be made.
  const hasSecondParents = column.parent2_count > 0;
  const [parentSlot, setParentSlot] = useState<ParentSlot | "">(hasSecondParents ? "" : "parent1");
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [fieldId, setFieldId] = useState<string>("");
  const [labelEn, setLabelEn] = useState(column.header);
  const [labelAr, setLabelAr] = useState(column.header);
  const [fieldType, setFieldType] = useState<FieldType>(column.suggested_field_type);
  const [sensitive, setSensitive] = useState(column.suggested_sensitive);
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<ImportColumnPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const form = useQuery({
    queryKey: recordFormKey(subjectKind),
    queryFn: () => fetchRecordForm(subjectKind),
  });
  const previewColumn = usePreviewImportColumn(importId);
  const applyColumn = useApplyImportColumn(importId);

  /** Every change to the target invalidates a preview already shown. */
  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setPreview(null);
      setDone(null);
    };
  }

  const typeOptions = [
    ...PLAIN_TYPES,
    ...(column.suggested_options.length > 0 ? (["single_choice"] as const) : []),
  ].map((type) => ({ value: type, label: t(`recordTemplates.types.${type}`) }));
  const fieldOptions = (form.data ?? []).map((field) => ({
    value: field.id,
    label:
      field.sensitivity === "sensitive"
        ? t(`${base}.sensitiveField`, { label: field.label_en })
        : field.label_en,
  }));

  function target(): ImportColumnTarget | null {
    if (subjectKind === "parent" && parentSlot === "") return null;
    const whose = {
      position: column.position,
      subject_kind: subjectKind,
      ...(subjectKind === "parent" ? { parent_slot: parentSlot as ParentSlot } : {}),
    };
    if (mode === "existing") {
      if (!fieldId) return null;
      return { ...whose, field_id: fieldId, overwrite };
    }
    if (!labelEn.trim() || !labelAr.trim()) return null;
    return {
      ...whose,
      overwrite,
      new_field: {
        label_en: labelEn.trim(),
        label_ar: labelAr.trim(),
        field_type: fieldType,
        options: fieldType === "single_choice" ? column.suggested_options : [],
        sensitivity: sensitive ? "sensitive" : "standard",
        visibility: "staff_only",
      },
    };
  }

  function handlePreview() {
    const body = target();
    if (!body) {
      setError(
        subjectKind === "parent" && parentSlot === ""
          ? t(`${base}.parentSlotRequired`)
          : t(`${base}.incomplete`),
      );
      return;
    }
    setError(null);
    previewColumn.mutate(body, {
      onSuccess: setPreview,
      onError: (failure) => setError(apiErrorMessage(failure, t(`${base}.previewError`))),
    });
  }

  function handleApply() {
    const body = target();
    if (!body || !preview) return;
    setError(null);
    applyColumn.mutate(
      { ...body, preview_token: preview.preview_token },
      {
        onSuccess: (result) => {
          setPreview(null);
          setDone(t(`${base}.done`, { count: result.written }));
        },
        onError: (failure) => {
          setPreview(null);
          setError(apiErrorMessage(failure, t(`${base}.applyError`)));
        },
      },
    );
  }

  return (
    <Modal open onClose={onClose} title={t(`${base}.title`, { header: column.header })}>
      <ModalBody>
        <p>{t(`${base}.intro`)}</p>

        <RadioGroup
          label={t(`${base}.subject`)}
          name="map-subject"
          value={subjectKind}
          onChange={(value) => {
            edit(setSubjectKind)(value as RecordSubjectKind);
            setFieldId("");
          }}
        >
          <Radio
            value="student"
            label={t(`${base}.subjectStudent`, { count: column.student_count })}
          />
          <Radio
            value="parent"
            label={t(`${base}.subjectParent`, {
              count: column.parent_count + column.parent2_count,
            })}
            disabled={column.parent_count + column.parent2_count === 0}
          />
        </RadioGroup>

        {subjectKind === "parent" && hasSecondParents ? (
          <RadioGroup
            label={t(`${base}.parentSlot`)}
            name="map-parent-slot"
            value={parentSlot}
            onChange={(value) => edit(setParentSlot)(value as ParentSlot)}
          >
            <Radio
              value="parent1"
              label={t(`${base}.parentSlotFirst`, { count: column.parent_count })}
              disabled={column.parent_count === 0}
            />
            <Radio
              value="parent2"
              label={t(`${base}.parentSlotSecond`, { count: column.parent2_count })}
            />
            <Radio value="both" label={t(`${base}.parentSlotBoth`)} />
          </RadioGroup>
        ) : null}

        <RadioGroup
          label={t(`${base}.target`)}
          name="map-target"
          value={mode}
          onChange={(value) => edit(setMode)(value as "existing" | "new")}
        >
          <Radio value="new" label={t(`${base}.targetNew`)} />
          <Radio value="existing" label={t(`${base}.targetExisting`)} />
        </RadioGroup>

        {mode === "existing" ? (
          fieldOptions.length > 0 ? (
            <Select
              label={t(`${base}.field`)}
              options={fieldOptions}
              value={fieldId || undefined}
              placeholder={t(`${base}.fieldPlaceholder`)}
              onChange={edit(setFieldId)}
            />
          ) : (
            <p>
              {form.isPending
                ? t("adminPeople.students.importHistory.common.loading")
                : t(`${base}.noFields`)}
            </p>
          )
        ) : (
          <div className="import-history__new-field">
            <Input
              label={t(`${base}.labelEn`)}
              value={labelEn}
              onChange={(event) => edit(setLabelEn)(event.target.value)}
              maxLength={200}
              required
            />
            <Input
              label={t(`${base}.labelAr`)}
              value={labelAr}
              dir="rtl"
              lang="ar"
              onChange={(event) => edit(setLabelAr)(event.target.value)}
              maxLength={200}
              required
            />
            <Select
              label={t(`${base}.type`)}
              options={typeOptions}
              value={fieldType}
              onChange={(value) => edit(setFieldType)(value as FieldType)}
              helperText={t(`${base}.typeSuggested`, {
                type: t(`recordTemplates.types.${column.suggested_field_type}`),
              })}
            />
            <Checkbox
              label={t(`${base}.sensitive`)}
              checked={sensitive}
              onChange={(event) => edit(setSensitive)(event.target.checked)}
            />
            {column.suggested_sensitive ? (
              <p className="import-history__hint">
                {t(`${base}.sensitiveHint.${column.sensitive_reason ?? "label"}`)}
              </p>
            ) : null}
          </div>
        )}

        <Checkbox
          label={t(`${base}.overwrite`)}
          checked={overwrite}
          onChange={(event) => edit(setOverwrite)(event.target.checked)}
        />

        {error ? <p role="alert">{error}</p> : null}
        {done ? <p role="status">{done}</p> : null}
        {preview ? <PreviewTable preview={preview} /> : null}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("adminPeople.students.importHistory.common.close")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={handlePreview}
          loading={previewColumn.isPending}
        >
          {t(`${base}.preview`)}
        </Button>
        <Button
          type="button"
          onClick={handleApply}
          loading={applyColumn.isPending}
          disabled={!preview || preview.totals.write === 0}
        >
          {t(`${base}.apply`, { count: preview?.totals.write ?? 0 })}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function PreviewTable({ preview }: { preview: ImportColumnPreview }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const base = "adminPeople.students.importHistory.preview";
  const totals = preview.totals;

  /** A date field's value reads as its first ten characters, whatever the serializer added. */
  function show(value: ImportColumnPreviewRow["value"], mask: string | null): string {
    if (mask) return mask;
    if (value === null) return "—";
    if (typeof value === "boolean") return t(value ? `${base}.yes` : `${base}.no`);
    if (Array.isArray(value)) return value.join(", ");
    if (preview.field.field_type === "date") return String(value).slice(0, 10);
    return String(value);
  }

  return (
    <section aria-labelledby="import-preview-heading" className="import-history__preview">
      <h3 id="import-preview-heading">{t(`${base}.heading`)}</h3>
      <ul className="import-history__totals">
        {(["write", "unchanged", "kept", "invalid", "conflict", "empty"] as const).map((key) => (
          <li key={key}>
            {t(`${base}.totals.${key}`, {
              count: totals[key],
              formatted: formatNumber(totals[key]),
            })}
          </li>
        ))}
      </ul>
      {preview.rows.length > 0 ? (
        <div className="import-history__table-wrap">
          <table className="import-history__table">
            <caption className="import-history__caption">
              {t(`${base}.caption`, { header: preview.header })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t(`${base}.columns.line`)}</th>
                <th scope="col">{t(`${base}.columns.person`)}</th>
                <th scope="col">{t(`${base}.columns.value`)}</th>
                <th scope="col">{t(`${base}.columns.current`)}</th>
                <th scope="col">{t(`${base}.columns.outcome`)}</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={row.subject_id}>
                  <td>{row.line_number}</td>
                  <td>
                    {row.name}
                    {row.admission_number ? ` (${row.admission_number})` : ""}
                  </td>
                  <td>{show(row.value, row.mask)}</td>
                  <td>{show(row.current_value, row.current_mask)}</td>
                  <td>
                    {t(`${base}.status.${row.status}`)}
                    {row.replaces_existing ? ` · ${t(`${base}.replaces`)}` : ""}
                    {row.reason ? ` · ${t(`${base}.reason.${row.reason}`)}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
