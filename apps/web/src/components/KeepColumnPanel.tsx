import { ApiError } from "@studafy/api-client";
import { Button, Checkbox, Input, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../lib/api";
import { useTranslation } from "../lib/i18n";

import type { components } from "@studafy/api-client";
import type { FormEvent } from "react";

type Preview = components["schemas"]["RecordImportPreview"];
type PreviewRow = Preview["rows"][number];
type ApplyResult = components["schemas"]["RecordImportApplyResult"];
type ColumnFieldType = components["schemas"]["RecordColumnFieldType"];
type FieldDefinition = components["schemas"]["RecordFieldDefinition"];

const FIELD_TYPES: readonly ColumnFieldType[] = [
  "short_text",
  "long_text",
  "number",
  "date",
  "single_choice",
  "multi_choice",
  "yes_no",
  "phone",
  "email",
];

/** Rows listed in the preview before collapsing into "and N more". */
const VISIBLE_ROWS = 50;

export interface KeepColumnRow {
  line: number;
  subjectId: string;
  value: string;
}

export interface KeepColumnPanelProps {
  subjectKind: "staff" | "class";
  header: string;
  /** The rows this import created, with the column's cell on each. */
  rows: KeepColumnRow[];
  canCreateField: boolean;
  onBack: () => void;
}

type RequestBody = components["schemas"]["RecordImportColumnBody"];

function errorDetail(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * "Keep as a record field" for one unknown column of a staff or class CSV import: choose a new
 * field (its type guessed from the values unless chosen) or an existing one, preview what would be
 * written row by row -- a sensitive value as its mask only -- then confirm. Nothing is written
 * before the confirm, and any change discards the preview. Only the rows this import created are
 * sent, by the id each create call returned; the API writes none it cannot prove the import made.
 */
export function KeepColumnPanel({
  subjectKind,
  header,
  rows,
  canCreateField,
  onBack,
}: KeepColumnPanelProps) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<"new" | "existing">(canCreateField ? "new" : "existing");
  const [labelEn, setLabelEn] = useState(header);
  const [labelAr, setLabelAr] = useState(header);
  const [fieldType, setFieldType] = useState<ColumnFieldType | "">("");
  const [sensitivity, setSensitivity] = useState<"standard" | "sensitive" | null>(null);
  const [fieldId, setFieldId] = useState("");
  const [preview, setPreview] = useState<{ body: RequestBody; result: Preview } | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useQuery({
    queryKey: ["records", "form", subjectKind],
    queryFn: async () => {
      const { data } = await api.GET("/api/record-forms/{subjectKind}", {
        params: { path: { subjectKind } },
      });
      // Restated as a plain array: the generated `readonly` array loses its prototype through
      // `api.GET`'s response typing (as records/queries.ts notes).
      const fields = (data?.fields ?? []) as FieldDefinition[];
      return fields.filter((field) => field.field_type !== "document");
    },
    enabled: mode === "existing",
  });

  /** Any edit discards the preview: what is confirmed is always what was last previewed. */
  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setPreview(null);
      setError(null);
    };
  }

  function requestBody(): RequestBody {
    const cells = rows.map((row) => ({
      line: row.line,
      subject_id: row.subjectId,
      value: row.value,
    }));
    if (mode === "existing") return { header, field_id: fieldId, overwrite: false, rows: cells };
    return {
      header,
      overwrite: false,
      rows: cells,
      new_field: {
        label_en: labelEn.trim(),
        label_ar: labelAr.trim(),
        visibility: "staff_only",
        ...(fieldType ? { field_type: fieldType } : {}),
        ...(sensitivity ? { sensitivity } : {}),
      },
    };
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    if (mode === "existing" && !fieldId) {
      setError(t("dataTransfer.keepColumn.chooseField"));
      return;
    }
    if (mode === "new" && (!labelEn.trim() || !labelAr.trim())) {
      setError(t("dataTransfer.keepColumn.labelsRequired"));
      return;
    }
    const body = requestBody();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.POST("/api/record-imports/{subjectKind}/preview", {
        params: { path: { subjectKind } },
        body,
      });
      if (data) setPreview({ body, result: data as Preview });
    } catch (caught) {
      setError(errorDetail(caught) ?? t("dataTransfer.keepColumn.previewError"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.POST("/api/record-imports/{subjectKind}/apply", {
        params: { path: { subjectKind } },
        body: { ...preview.body, preview_token: preview.result.preview_token },
      });
      if (data) setApplied(data);
    } catch (caught) {
      setPreview(null);
      setError(errorDetail(caught) ?? t("dataTransfer.keepColumn.applyError"));
    } finally {
      setBusy(false);
    }
  }

  if (applied) {
    return (
      <div className="data-transfer__keep">
        <p role="status">
          {t("dataTransfer.keepColumn.done", { count: applied.written, column: header })}
        </p>
        <Button variant="secondary" onClick={onBack}>
          {t("dataTransfer.keepColumn.back")}
        </Button>
      </div>
    );
  }

  const result = preview?.result;
  const shownSensitivity = sensitivity ?? result?.field.sensitivity ?? "standard";
  const display = (row: PreviewRow): string => {
    if (row.mask) return row.mask;
    if (row.value === null) return "—";
    if (Array.isArray(row.value)) return row.value.join(", ");
    if (typeof row.value === "boolean") {
      return t(row.value ? "dataTransfer.keepColumn.yes" : "dataTransfer.keepColumn.no");
    }
    // A date answer is a calendar day: only its first ten characters mean anything.
    if (result?.field.field_type === "date") return String(row.value).slice(0, 10);
    return String(row.value);
  };
  const reasonText = (row: PreviewRow): string | null => {
    if (!row.reason) return null;
    if (row.reason === "NOT_CREATED_BY_IMPORT" || row.reason === "NOT_STAFF") {
      return t(`dataTransfer.keepColumn.reasons.${row.reason}`);
    }
    if (row.reason === "CONFLICTING_VALUES") return t("dataTransfer.keepColumn.reasons.conflict");
    return t("dataTransfer.keepColumn.reasons.invalid");
  };

  return (
    <form className="data-transfer__keep" onSubmit={(event) => void runPreview(event)} noValidate>
      <h3>{t("dataTransfer.keepColumn.title", { column: header })}</h3>
      <p className="data-transfer__muted">
        {t("dataTransfer.keepColumn.intro", { count: rows.length })}
      </p>

      {canCreateField ? (
        <Select
          label={t("dataTransfer.keepColumn.target")}
          options={[
            { value: "new", label: t("dataTransfer.keepColumn.newField") },
            { value: "existing", label: t("dataTransfer.keepColumn.existingField") },
          ]}
          value={mode}
          onChange={edit((value: string) => setMode(value as "new" | "existing"))}
        />
      ) : null}

      {mode === "new" ? (
        <>
          <Input
            label={t("dataTransfer.keepColumn.labelEn")}
            value={labelEn}
            onChange={(event) => edit(setLabelEn)(event.target.value)}
          />
          <Input
            label={t("dataTransfer.keepColumn.labelAr")}
            value={labelAr}
            dir="rtl"
            onChange={(event) => edit(setLabelAr)(event.target.value)}
          />
          <Select
            label={t("dataTransfer.keepColumn.type")}
            options={[
              { value: "", label: t("dataTransfer.keepColumn.guessType") },
              ...FIELD_TYPES.map((type) => ({
                value: type,
                label: t(`dataTransfer.keepColumn.types.${type}`),
              })),
            ]}
            value={fieldType}
            onChange={edit((value: string) => setFieldType(value as ColumnFieldType | ""))}
            helperText={
              result && !fieldType
                ? t("dataTransfer.keepColumn.guessed", {
                    type: t(`dataTransfer.keepColumn.types.${result.field.field_type}`),
                  })
                : undefined
            }
          />
          {subjectKind === "staff" ? (
            <Checkbox
              label={t("dataTransfer.keepColumn.sensitive")}
              checked={shownSensitivity === "sensitive"}
              onChange={(event) =>
                edit(setSensitivity)(event.target.checked ? "sensitive" : "standard")
              }
            />
          ) : null}
          {result?.suggested_sensitive && sensitivity === null ? (
            <p className="data-transfer__muted" role="note">
              {t("dataTransfer.keepColumn.suggestedSensitive")}
            </p>
          ) : null}
        </>
      ) : (
        <Select
          label={t("dataTransfer.keepColumn.field")}
          options={[
            { value: "", label: t("dataTransfer.keepColumn.chooseField") },
            ...(form.data ?? []).map((field) => ({
              value: field.id,
              label: i18n.language === "ar" ? field.label_ar : field.label_en,
            })),
          ]}
          value={fieldId}
          onChange={edit(setFieldId)}
          disabled={form.isPending}
        />
      )}

      {error ? (
        <p role="alert" className="data-transfer__error">
          {error}
        </p>
      ) : null}

      {result ? (
        <section aria-label={t("dataTransfer.keepColumn.previewTitle")}>
          <p role="status">
            {t("dataTransfer.keepColumn.summary", {
              write: result.totals.write,
              skipped: result.totals.skipped,
              invalid: result.totals.invalid + result.totals.conflict,
            })}
          </p>
          <table className="data-transfer__preview">
            <caption>{t("dataTransfer.keepColumn.previewTitle")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("dataTransfer.keepColumn.columns.line")}</th>
                <th scope="col">{t("dataTransfer.keepColumn.columns.name")}</th>
                <th scope="col">{t("dataTransfer.keepColumn.columns.value")}</th>
                <th scope="col">{t("dataTransfer.keepColumn.columns.outcome")}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, VISIBLE_ROWS).map((row) => (
                <tr key={`${row.line_number}-${row.subject_id}`}>
                  <td>{row.line_number}</td>
                  <td>{row.name || "—"}</td>
                  <td>{display(row)}</td>
                  <td>
                    {t(`dataTransfer.keepColumn.status.${row.status}`)}
                    {reasonText(row) ? (
                      <span className="data-transfer__muted"> · {reasonText(row)}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.rows.length > VISIBLE_ROWS ? (
            <p className="data-transfer__muted">
              {t("dataTransfer.import.moreIssues", { count: result.rows.length - VISIBLE_ROWS })}
            </p>
          ) : null}
        </section>
      ) : null}

      <div className="data-transfer__pick">
        <Button type="button" variant="tertiary" onClick={onBack}>
          {t("dataTransfer.keepColumn.back")}
        </Button>
        <Button type="submit" variant="secondary" loading={busy && !preview}>
          {t("dataTransfer.keepColumn.preview")}
        </Button>
        {result ? (
          <Button
            type="button"
            loading={busy}
            disabled={result.totals.write === 0}
            onClick={() => void confirm()}
          >
            {t("dataTransfer.keepColumn.confirm", { count: result.totals.write })}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
