import {
  MINISTRY_EXPORT_ENCODINGS,
  MINISTRY_EXPORT_FIELDS,
  MINISTRY_EXPORT_FILE_FORMATS,
  MINISTRY_EXPORT_LIMITS,
  MINISTRY_EXPORT_ROW_KINDS,
  validateMinistryExportTemplate,
} from "@studafy/grading-engine";
import { Button, Checkbox, Input, Select, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { downloadBlob } from "../../../lib/csv";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSubjects, useTerms } from "../school/queries";
import { useGradeLevels } from "../sections/queries";

import { Badge, ConfirmModal, SeverityBadge, TextArea } from "./components";
import { newKey } from "./config-form";
import { problemMessage } from "./errors";
import {
  fetchMinistryExportFile,
  useDeleteMinistryExportTemplate,
  useMinistryExportExamples,
  useMinistryExportTemplates,
  useNationalIdFields,
  usePreviewMinistryExport,
  useSaveMinistryExportTemplate,
} from "./ministry-export";

import type { SetupContext } from "./context";
import type {
  MinistryExportEncoding,
  MinistryExportExample,
  MinistryExportField,
  MinistryExportFileFormat,
  MinistryExportIssue,
  MinistryExportRowKind,
  MinistryExportRunBody,
  MinistryExportTemplate,
  MinistryExportTemplateBody,
} from "./ministry-export";
import type { MinistryExportTemplateDefinition, ValidationIssue } from "@studafy/grading-engine";
import type { TFunction } from "i18next";

interface ColumnDraft {
  key: string;
  header: string;
  field: MinistryExportField;
  constantValue: string;
  /** One "our value = ministry value" per line. */
  valueMap: string;
}

interface TemplateDraft {
  name: string;
  target: string;
  fileFormat: MinistryExportFileFormat;
  encoding: MinistryExportEncoding;
  rowKind: MinistryExportRowKind;
  decimals: string;
  nationalIdFieldId: string | undefined;
  columns: ColumnDraft[];
  /** subject id -> the ministry's code. */
  subjectCodes: Record<string, string>;
}

type TemplateShape = Pick<
  MinistryExportTemplate,
  "name" | "target" | "file_format" | "encoding" | "row_kind" | "decimal_places" | "columns"
>;

function columnDraft(column: TemplateShape["columns"][number] | null): ColumnDraft {
  return {
    key: newKey("column"),
    header: column?.header ?? "",
    field: column?.field ?? "admission_number",
    constantValue: column?.constant_value ?? "",
    valueMap: (column?.value_map ?? []).map((entry) => `${entry.from} = ${entry.to}`).join("\n"),
  };
}

function draftFrom(
  template: TemplateShape | null,
  extra?: Pick<MinistryExportTemplate, "national_id_field" | "subject_codes">,
): TemplateDraft {
  return {
    name: template?.name ?? "",
    target: template?.target ?? "",
    fileFormat: template?.file_format ?? "csv",
    encoding: template?.encoding ?? "utf8_bom",
    rowKind: template?.row_kind ?? "subject",
    decimals: String(template?.decimal_places ?? 2),
    nationalIdFieldId: extra?.national_id_field?.id,
    columns: template ? template.columns.map(columnDraft) : [columnDraft(null)],
    subjectCodes: Object.fromEntries(
      (extra?.subject_codes ?? []).map((code) => [code.subject_id, code.code]),
    ),
  };
}

/** A value map's lines as pairs; `bad` lists the lines with no "=". */
export function parseValueMap(text: string): {
  entries: { from: string; to: string }[];
  bad: string[];
} {
  const entries: { from: string; to: string }[] = [];
  const bad: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf("=");
    if (at < 0) {
      bad.push(line.trim());
      continue;
    }
    entries.push({ from: line.slice(0, at).trim(), to: line.slice(at + 1).trim() });
  }
  return { entries, bad };
}

function definitionOf(draft: TemplateDraft): MinistryExportTemplateDefinition {
  return {
    name: draft.name,
    target: draft.target,
    fileFormat: draft.fileFormat,
    encoding: draft.encoding,
    rowKind: draft.rowKind,
    decimalPlaces: draft.decimals.trim() === "" ? Number.NaN : Number(draft.decimals),
    columns: draft.columns.map((column) => ({
      header: column.header,
      field: column.field,
      constantValue: column.field === "constant" ? column.constantValue : null,
      valueMap: column.field === "constant" ? [] : parseValueMap(column.valueMap).entries,
    })),
  };
}

function bodyOf(draft: TemplateDraft): MinistryExportTemplateBody {
  const definition = definitionOf(draft);
  return {
    name: definition.name.trim(),
    target: definition.target.trim(),
    file_format: definition.fileFormat,
    encoding: definition.encoding,
    row_kind: definition.rowKind,
    decimal_places: definition.decimalPlaces,
    national_id_field_id: draft.nationalIdFieldId ?? null,
    columns: definition.columns.map((column) => ({
      header: column.header.trim(),
      field: column.field,
      constant_value: column.constantValue === null ? null : column.constantValue.trim(),
      value_map: [...column.valueMap],
    })),
    subject_codes:
      definition.rowKind === "subject"
        ? Object.entries(draft.subjectCodes)
            .filter(([, code]) => code.trim() !== "")
            .map(([subject_id, code]) => ({ subject_id, code: code.trim() }))
        : [],
  };
}

const fileLabel = (
  t: TFunction,
  template: Pick<MinistryExportTemplate, "file_format" | "encoding">,
) =>
  template.file_format === "xlsx"
    ? t("academicGrading.ministryExport.format.xlsx")
    : t(`academicGrading.ministryExport.encoding.${template.encoding}`);

/**
 * Ministry results export: the school's export templates (target, file type, encoding, columns
 * mapped to known fields, value maps, the ministry's subject codes), not tied to the selected
 * year, and running one over the selected year's finalized results with a preview and a check of
 * what is missing. Built-in examples are starting points, never official formats. Leadership only.
 */
export function MinistryExportTab({ ctx }: { ctx: SetupContext }) {
  const { t, i18n } = useTranslation();
  const { show } = useToast();
  const canEdit = ctx.can.manage;
  const templates = useMinistryExportTemplates();
  const examples = useMinistryExportExamples(canEdit);
  const remove = useDeleteMinistryExportTemplate();
  const [editing, setEditing] = useState<{
    template: MinistryExportTemplate | null;
    example: MinistryExportExample | null;
  } | null>(null);
  const [exampleKey, setExampleKey] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<MinistryExportTemplate | null>(null);
  const arabic = i18n.language === "ar";

  if (editing) {
    return (
      <TemplateEditor
        template={editing.template}
        example={editing.example}
        readOnly={!canEdit}
        onClose={() => setEditing(null)}
      />
    );
  }

  const chosenExample = (examples.data ?? []).find((example) => example.key === exampleKey);
  return (
    <>
      <section className="ag-block" aria-labelledby="ag-ministry-heading">
        <div className="ag-head">
          <h2 id="ag-ministry-heading">{t("academicGrading.ministryExport.heading")}</h2>
          {canEdit ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditing({ template: null, example: null })}
            >
              {t("academicGrading.ministryExport.add")}
            </Button>
          ) : null}
        </div>
        <p className="ag-muted">{t("academicGrading.ministryExport.help")}</p>
        {canEdit ? (
          <div className="ag-row ag-grid ag-grid--dense">
            <Select
              label={t("academicGrading.ministryExport.exampleLabel")}
              placeholder={t("academicGrading.ministryExport.examplePlaceholder")}
              helperText={t("academicGrading.ministryExport.exampleHelp")}
              options={(examples.data ?? []).map((example) => ({
                value: example.key,
                label: arabic ? example.name_ar : example.name_en,
              }))}
              value={exampleKey}
              disabled={examples.isPending}
              onChange={setExampleKey}
            />
            <div className="ag-row__actions">
              <Button
                type="button"
                variant="secondary"
                disabled={!chosenExample}
                onClick={() =>
                  chosenExample && setEditing({ template: null, example: chosenExample })
                }
              >
                {t("academicGrading.ministryExport.startFromExample")}
              </Button>
            </div>
          </div>
        ) : null}
        <Table caption={t("academicGrading.ministryExport.caption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {t("academicGrading.ministryExport.columns.name")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.ministryExport.columns.file")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.ministryExport.columns.rows")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.ministryExport.columns.actions")}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={4}
            loading={templates.isPending}
            empty={
              templates.isError
                ? problemMessage(templates.error, t)
                : t("academicGrading.ministryExport.empty")
            }
          >
            {(templates.data ?? []).map((template) => (
              <Table.Row key={template.id}>
                <Table.Cell>
                  <strong>{template.name}</strong>
                  {template.target ? <div className="ag-muted">{template.target}</div> : null}
                </Table.Cell>
                <Table.Cell>{fileLabel(t, template)}</Table.Cell>
                <Table.Cell>
                  {t(`academicGrading.ministryExport.rowKind.${template.row_kind}`)} ·{" "}
                  {t("academicGrading.ministryExport.columnCount", {
                    count: template.columns.length,
                  })}
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={t("academicGrading.ministryExport.editLabel", {
                        name: template.name,
                      })}
                      onClick={() => setEditing({ template, example: null })}
                    >
                      {canEdit
                        ? t("academicGrading.common.edit")
                        : t("academicGrading.common.view")}
                    </Button>
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("academicGrading.ministryExport.deleteLabel", {
                          name: template.name,
                        })}
                        onClick={() => setPendingDelete(template)}
                      >
                        {t("academicGrading.common.remove")}
                      </Button>
                    ) : null}
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        <ConfirmModal
          open={pendingDelete !== null}
          title={t("academicGrading.ministryExport.deleteTitle", {
            name: pendingDelete?.name ?? "",
          })}
          description={t("academicGrading.ministryExport.deleteDescription")}
          confirmLabel={t("academicGrading.common.remove")}
          submitting={remove.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() =>
            pendingDelete &&
            remove.mutate(pendingDelete.id, {
              onSuccess: () => {
                show({ variant: "success", title: t("academicGrading.ministryExport.deleted") });
                setPendingDelete(null);
              },
              onError: (error) => {
                show({
                  variant: "error",
                  title: t("academicGrading.ministryExport.deleteFailed"),
                  description: problemMessage(error, t),
                });
                setPendingDelete(null);
              },
            })
          }
        />
      </section>
      {(templates.data ?? []).length > 0 ? (
        <RunExport ctx={ctx} templates={templates.data ?? []} />
      ) : null}
    </>
  );
}

function issueText(issue: MinistryExportIssue, t: TFunction): string {
  return t(`academicGrading.ministryExport.issues.${issue.code}`, {
    student: issue.student_name ?? "",
    number: issue.admission_number ?? "",
    subject: issue.subject_name ?? "",
    code: issue.subject_code ?? "",
    grade: issue.grade_level_name ?? "",
    section: issue.section_name ?? "",
  });
}

/** Preview and download a template over the selected year's finalized results. */
function RunExport({
  ctx,
  templates,
}: {
  ctx: SetupContext;
  templates: readonly MinistryExportTemplate[];
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const terms = useTerms(ctx.year.id);
  const grades = useGradeLevels();
  const preview = usePreviewMinistryExport();
  const [templateId, setTemplateId] = useState<string | undefined>(templates[0]?.id);
  const [period, setPeriod] = useState<string>("annual");
  const [gradeLevelIds, setGradeLevelIds] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const template = templates.find((candidate) => candidate.id === templateId);

  const body: MinistryExportRunBody | null = templateId
    ? {
        template_id: templateId,
        academic_year_id: ctx.year.id,
        term_id: period === "annual" ? null : period,
        grade_level_ids: gradeLevelIds,
      }
    : null;
  const reset = () => preview.reset();

  async function download() {
    if (!body || !template) return;
    setDownloading(true);
    try {
      const file = await fetchMinistryExportFile(body, template.file_format);
      downloadBlob(file.fileName, file.blob);
    } catch (error) {
      show({
        variant: "error",
        title: t("academicGrading.ministryExport.run.downloadFailed"),
        description: problemMessage(error, t),
      });
    } finally {
      setDownloading(false);
    }
  }

  const result = preview.data;
  const errors = (result?.issues ?? []).filter((issue) => issue.severity === "error").length;
  return (
    <section className="ag-block" aria-labelledby="ag-ministry-run-heading">
      <h2 id="ag-ministry-run-heading">{t("academicGrading.ministryExport.run.heading")}</h2>
      <p className="ag-muted">
        {t("academicGrading.ministryExport.run.help", { year: ctx.year.name })}
      </p>
      <div className="ag-row ag-grid ag-grid--dense">
        <Select
          label={t("academicGrading.ministryExport.run.template")}
          options={templates.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
          value={templateId}
          onChange={(id) => {
            setTemplateId(id);
            reset();
          }}
        />
        <Select
          label={t("academicGrading.ministryExport.run.period")}
          options={[
            { value: "annual", label: t("academicGrading.ministryExport.run.annual") },
            ...(terms.data ?? []).map((term) => ({ value: term.id, label: term.name })),
          ]}
          value={period}
          onChange={(value) => {
            setPeriod(value);
            reset();
          }}
        />
      </div>
      <fieldset className="ag-fieldset">
        <legend>{t("academicGrading.ministryExport.run.grades")}</legend>
        <p className="ag-muted">{t("academicGrading.ministryExport.run.gradesHelp")}</p>
        <div className="ag-checks">
          {(grades.data ?? []).map((grade) => (
            <Checkbox
              key={grade.id}
              label={grade.name}
              checked={gradeLevelIds.includes(grade.id)}
              onChange={(event) => {
                setGradeLevelIds((prev) =>
                  event.target.checked
                    ? [...prev, grade.id]
                    : prev.filter((candidate) => candidate !== grade.id),
                );
                reset();
              }}
            />
          ))}
        </div>
      </fieldset>
      <div className="ag-actions">
        <Button
          type="button"
          variant="secondary"
          loading={preview.isPending}
          disabled={!body}
          onClick={() => body && preview.mutate(body)}
        >
          {t("academicGrading.ministryExport.run.preview")}
        </Button>
        <Button type="button" loading={downloading} disabled={!body} onClick={download}>
          {t("academicGrading.ministryExport.run.download", {
            format: template ? fileLabel(t, template) : "",
          })}
        </Button>
      </div>
      {preview.isError ? (
        <p className="ag-error" role="alert">
          {problemMessage(preview.error, t)}
        </p>
      ) : null}
      {result ? (
        <div className="ag-card" aria-label={t("academicGrading.ministryExport.run.previewLabel")}>
          <p>
            {t("academicGrading.ministryExport.run.summary", {
              rows: formatNumber(result.total_rows),
              students: formatNumber(result.students),
              sections: formatNumber(result.sections_included),
            })}
          </p>
          {result.national_ids_masked ? (
            <p className="ag-notice" role="note">
              {t("academicGrading.ministryExport.run.masked")}
            </p>
          ) : null}
          {result.issues.length === 0 ? (
            <p>{t("academicGrading.ministryExport.run.noIssues")}</p>
          ) : (
            <>
              {errors > 0 ? (
                <p className="ag-notice" role="note">
                  {t("academicGrading.ministryExport.run.fixFirst")}
                </p>
              ) : null}
              <ul className="ag-issues" aria-label={t("academicGrading.ministryExport.run.issues")}>
                {result.issues.map((issue, index) => (
                  <li
                    key={`${issue.code}-${issue.student_id ?? issue.subject_id ?? issue.section_id ?? index}`}
                    className="ag-issues__item"
                  >
                    <SeverityBadge severity={issue.severity} /> <span>{issueText(issue, t)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.total_rows > 0 ? (
            <div className="ag-table-scroll">
              <Table caption={t("academicGrading.ministryExport.run.previewLabel")} hideCaption>
                <Table.Header>
                  <Table.Row>
                    {result.header.map((header, index) => (
                      <Table.HeaderCell key={`${index}-${header}`}>{header}</Table.HeaderCell>
                    ))}
                  </Table.Row>
                </Table.Header>
                <Table.Body columnCount={result.header.length}>
                  {result.rows.map((row, rowIndex) => (
                    <Table.Row key={rowIndex}>
                      {row.cells.map((cell, index) => (
                        <Table.Cell key={index}>{cell}</Table.Cell>
                      ))}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
              {result.total_rows > result.rows.length ? (
                <p className="ag-muted">
                  {t("academicGrading.ministryExport.run.firstRows", {
                    shown: formatNumber(result.rows.length),
                    total: formatNumber(result.total_rows),
                  })}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="ag-muted">{t("academicGrading.ministryExport.run.noRows")}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function TemplateEditor({
  template,
  example,
  readOnly,
  onClose,
}: {
  template: MinistryExportTemplate | null;
  example: MinistryExportExample | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { show } = useToast();
  const save = useSaveMinistryExportTemplate();
  const subjects = useSubjects();
  const nationalIdFields = useNationalIdFields();
  const [draft, setDraft] = useState<TemplateDraft>(() =>
    template ? draftFrom(template, template) : draftFrom(example?.template ?? null),
  );
  const arabic = i18n.language === "ar";

  const usesNationalId = draft.columns.some((column) => column.field === "national_id");
  const issues = useMemo(() => {
    const found: (ValidationIssue & { key: string })[] = validateMinistryExportTemplate(
      definitionOf(draft),
    ).map((issue, index) => ({ ...issue, key: `${issue.code}-${issue.ref ?? index}` }));
    draft.columns.forEach((column, index) => {
      if (column.field === "constant") return;
      for (const line of parseValueMap(column.valueMap).bad) {
        found.push({
          key: `${column.key}-bad-${line}`,
          code: "VALUE_MAP_LINE",
          severity: "error",
          message: t("academicGrading.ministryExport.valueMapLine", { n: index + 1, line }),
        });
      }
    });
    if (usesNationalId && draft.nationalIdFieldId === undefined) {
      found.push({
        key: "national-id-field",
        code: "NATIONAL_ID_FIELD",
        severity: "warning",
        message: t("academicGrading.ministryExport.nationalIdFieldMissing"),
      });
    }
    return found;
  }, [draft, t, usesNationalId]);
  const blocking = issues.some((issue) => issue.severity === "error");

  const patch = (changes: Partial<TemplateDraft>) => setDraft((prev) => ({ ...prev, ...changes }));
  const patchColumn = (key: string, changes: Partial<ColumnDraft>) =>
    setDraft((prev) => ({
      ...prev,
      columns: prev.columns.map((column) =>
        column.key === key ? { ...column, ...changes } : column,
      ),
    }));
  const moveColumn = (index: number, by: -1 | 1) =>
    setDraft((prev) => {
      const columns = [...prev.columns];
      const [moved] = columns.splice(index, 1);
      columns.splice(index + by, 0, moved!);
      return { ...prev, columns };
    });

  function submit() {
    save.mutate(
      { templateId: template?.id ?? null, body: bodyOf(draft) },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.ministryExport.saved") });
          onClose();
        },
      },
    );
  }

  const fieldOptions = MINISTRY_EXPORT_FIELDS.map((field) => ({
    value: field,
    label: t(`academicGrading.ministryExport.fields.${field}`),
  }));
  return (
    <section className="ag-editor" aria-labelledby="ag-ministry-editor-heading">
      <div className="ag-head">
        <h2 id="ag-ministry-editor-heading">
          {template
            ? t("academicGrading.ministryExport.editTitle", { name: template.name })
            : t("academicGrading.ministryExport.add")}
        </h2>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
      </div>
      {example ? (
        <p className="ag-notice" role="note">
          <Badge tone="warning">{t("academicGrading.ministryExport.exampleBadge")}</Badge>{" "}
          {arabic ? example.note_ar : example.note_en}
        </p>
      ) : null}

      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.ministryExport.details")}</legend>
        <div className="ag-grid ag-grid--dense">
          <Input
            label={t("academicGrading.ministryExport.name")}
            value={draft.name}
            required
            maxLength={MINISTRY_EXPORT_LIMITS.nameMaxLength}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <Input
            label={t("academicGrading.ministryExport.target")}
            helperText={t("academicGrading.ministryExport.targetHelp")}
            value={draft.target}
            maxLength={MINISTRY_EXPORT_LIMITS.targetMaxLength}
            onChange={(event) => patch({ target: event.target.value })}
          />
          <Select<MinistryExportFileFormat>
            label={t("academicGrading.ministryExport.fileFormat")}
            options={MINISTRY_EXPORT_FILE_FORMATS.map((format) => ({
              value: format,
              label: t(`academicGrading.ministryExport.format.${format}`),
            }))}
            value={draft.fileFormat}
            onChange={(fileFormat) => patch({ fileFormat })}
          />
          {draft.fileFormat === "csv" ? (
            <Select<MinistryExportEncoding>
              label={t("academicGrading.ministryExport.encodingLabel")}
              options={MINISTRY_EXPORT_ENCODINGS.map((encoding) => ({
                value: encoding,
                label: t(`academicGrading.ministryExport.encoding.${encoding}`),
              }))}
              value={draft.encoding}
              onChange={(encoding) => patch({ encoding })}
            />
          ) : null}
          <Select<MinistryExportRowKind>
            label={t("academicGrading.ministryExport.rowKindLabel")}
            options={MINISTRY_EXPORT_ROW_KINDS.map((kind) => ({
              value: kind,
              label: t(`academicGrading.ministryExport.rowKind.${kind}`),
            }))}
            value={draft.rowKind}
            onChange={(rowKind) => patch({ rowKind })}
          />
          <Input
            label={t("academicGrading.ministryExport.decimals")}
            type="number"
            min={0}
            max={MINISTRY_EXPORT_LIMITS.maxDecimalPlaces}
            step={1}
            value={draft.decimals}
            onChange={(event) => patch({ decimals: event.target.value })}
          />
          <Select
            label={t("academicGrading.ministryExport.nationalIdField")}
            helperText={t("academicGrading.ministryExport.nationalIdFieldHelp")}
            placeholder={t("academicGrading.ministryExport.nationalIdFieldNone")}
            options={[
              { value: "", label: t("academicGrading.ministryExport.nationalIdFieldNone") },
              ...(nationalIdFields.data ?? []).map((field) => ({
                value: field.id,
                label:
                  (arabic ? field.label_ar : field.label_en) +
                  (field.sensitivity === "sensitive"
                    ? ` (${t("academicGrading.ministryExport.sensitive")})`
                    : ""),
              })),
            ]}
            value={draft.nationalIdFieldId ?? ""}
            disabled={nationalIdFields.isPending}
            onChange={(id) => patch({ nationalIdFieldId: id === "" ? undefined : id })}
          />
        </div>
      </fieldset>

      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.ministryExport.columnsLegend")}</legend>
        <p className="ag-muted">{t("academicGrading.ministryExport.columnsHelp")}</p>
        {draft.columns.map((column, index) => (
          <div
            key={column.key}
            className="ag-row"
            role="group"
            aria-label={t("academicGrading.ministryExport.columnN", { n: index + 1 })}
          >
            <div className="ag-grid ag-grid--dense">
              <Input
                label={t("academicGrading.ministryExport.header")}
                value={column.header}
                required
                maxLength={MINISTRY_EXPORT_LIMITS.headerMaxLength}
                onChange={(event) => patchColumn(column.key, { header: event.target.value })}
              />
              <Select<MinistryExportField>
                label={t("academicGrading.ministryExport.field")}
                options={fieldOptions}
                value={column.field}
                onChange={(field) => patchColumn(column.key, { field })}
              />
              {column.field === "constant" ? (
                <Input
                  label={t("academicGrading.ministryExport.constant")}
                  value={column.constantValue}
                  required
                  maxLength={MINISTRY_EXPORT_LIMITS.valueMaxLength}
                  onChange={(event) =>
                    patchColumn(column.key, { constantValue: event.target.value })
                  }
                />
              ) : (
                <TextArea
                  label={t("academicGrading.ministryExport.valueMap")}
                  value={column.valueMap}
                  rows={2}
                  disabled={readOnly}
                  onChange={(valueMap) => patchColumn(column.key, { valueMap })}
                />
              )}
            </div>
            <div className="ag-row__actions">
              <Button
                type="button"
                variant="tertiary"
                disabled={index === 0}
                aria-label={t("academicGrading.ministryExport.moveUp", { n: index + 1 })}
                onClick={() => moveColumn(index, -1)}
              >
                {t("academicGrading.ministryExport.up")}
              </Button>
              <Button
                type="button"
                variant="tertiary"
                disabled={index === draft.columns.length - 1}
                aria-label={t("academicGrading.ministryExport.moveDown", { n: index + 1 })}
                onClick={() => moveColumn(index, 1)}
              >
                {t("academicGrading.ministryExport.down")}
              </Button>
              <Button
                type="button"
                variant="tertiary"
                aria-label={t("academicGrading.ministryExport.removeColumn", { n: index + 1 })}
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    columns: prev.columns.filter((candidate) => candidate.key !== column.key),
                  }))
                }
              >
                {t("academicGrading.common.remove")}
              </Button>
            </div>
          </div>
        ))}
        <p className="ag-muted">{t("academicGrading.ministryExport.valueMapHelp")}</p>
        <Button
          type="button"
          variant="secondary"
          disabled={draft.columns.length >= MINISTRY_EXPORT_LIMITS.maxColumns}
          onClick={() =>
            setDraft((prev) => ({ ...prev, columns: [...prev.columns, columnDraft(null)] }))
          }
        >
          {t("academicGrading.ministryExport.addColumn")}
        </Button>
      </fieldset>

      {draft.rowKind === "subject" ? (
        <fieldset className="ag-fieldset" disabled={readOnly}>
          <legend>{t("academicGrading.ministryExport.subjectCodes")}</legend>
          <p className="ag-muted">{t("academicGrading.ministryExport.subjectCodesHelp")}</p>
          <div className="ag-grid ag-grid--dense">
            {(subjects.data ?? []).map((subject) => (
              <Input
                key={subject.id}
                label={`${subject.name} (${subject.code})`}
                value={draft.subjectCodes[subject.id] ?? ""}
                maxLength={MINISTRY_EXPORT_LIMITS.subjectCodeMaxLength}
                onChange={(event) =>
                  patch({
                    subjectCodes: { ...draft.subjectCodes, [subject.id]: event.target.value },
                  })
                }
              />
            ))}
          </div>
        </fieldset>
      ) : null}

      <section className="ag-card ag-check" aria-label={t("academicGrading.editor.check")}>
        {issues.length === 0 ? (
          <p>{t("academicGrading.ministryExport.valid")}</p>
        ) : (
          <ul className="ag-issues">
            {issues.map((issue) => (
              <li key={issue.key} className="ag-issues__item">
                <SeverityBadge severity={issue.severity === "error" ? "error" : "warning"} />{" "}
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {save.isError ? (
        <p className="ag-error" role="alert">
          {problemMessage(save.error, t)}
        </p>
      ) : null}
      <div className="ag-actions">
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.cancel")}
        </Button>
        {readOnly ? null : (
          <Button type="button" loading={save.isPending} disabled={blocking} onClick={submit}>
            {t("academicGrading.ministryExport.save")}
          </Button>
        )}
      </div>
    </section>
  );
}
