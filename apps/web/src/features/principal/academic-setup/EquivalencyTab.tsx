import {
  EQUIVALENCY_EXAMPLES,
  EQUIVALENCY_PART_TYPES,
  EQUIVALENCY_SOURCE_SYSTEMS,
  validateEquivalencyParts,
} from "@studafy/grading-engine";
import { Button, Checkbox, Input, Select, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { buildCsv, downloadCsv } from "../../../lib/csv";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSubjects } from "../school/queries";
import { useGradeLevels } from "../sections/queries";

import { Badge, ConfirmModal, QueryState, SeverityBadge } from "./components";
import { newKey } from "./config-form";
import {
  useDeleteEquivalencyRuleSet,
  useEquivalencyRuleSets,
  useEquivalencyStudentList,
  useSaveEquivalencyRuleSet,
} from "./equivalency";
import {
  EquivalencyStatusBadge,
  EstimateNotice,
  equivalencyIssueText,
} from "./EquivalencyBreakdown";
import { problemMessage } from "./errors";
import { useExternalExams } from "./external-exams";

import type { SetupContext } from "./context";
import type {
  EquivalencyPart,
  EquivalencyPartType,
  EquivalencyRuleSet,
  EquivalencyRuleSetBody,
  EquivalencySourceSystem,
} from "./equivalency";
import type { EquivalencyPartDefinition, ValidationIssue } from "@studafy/grading-engine";

type ConversionMode = "table" | "linear";
type GpaBasis = "gpa" | "weighted_gpa";

interface RowDraft {
  key: string;
  first: string;
  percentage: string;
}

interface PartDraft {
  key: string;
  type: EquivalencyPartType;
  label: string;
  weight: string;
  required: boolean;
  examIds: string[];
  bestCount: string;
  minCount: string;
  requiredSubjectIds: string[];
  grades: RowDraft[];
  mode: ConversionMode;
  bands: RowDraft[];
  slope: string;
  intercept: string;
  requireAwarded: boolean;
  gpaBasis: GpaBasis;
}

interface SetDraft {
  name: string;
  sourceSystem: EquivalencySourceSystem;
  gradeLevelIds: string[];
  isActive: boolean;
  visible: boolean;
  parts: PartDraft[];
}

const row = (first: string, percentage: string): RowDraft => ({
  key: newKey("row"),
  first,
  percentage,
});

function blankPart(type: EquivalencyPartType = "exam_subjects"): PartDraft {
  return {
    key: newKey("part"),
    type,
    label: "",
    weight: "100",
    required: true,
    examIds: [],
    bestCount: "",
    minCount: "",
    requiredSubjectIds: [],
    grades: [row("", "")],
    mode: "table",
    bands: [row("", "")],
    slope: "",
    intercept: "",
    requireAwarded: type === "diploma_total",
    gpaBasis: "gpa",
  };
}

const text = (value: number | null) => (value === null ? "" : String(value));

function partDraft(part: EquivalencyPart): PartDraft {
  return {
    key: newKey("part"),
    type: part.type,
    label: part.label,
    weight: String(part.weight),
    required: part.required,
    examIds: [...part.exam_ids],
    bestCount: text(part.best_count),
    minCount: text(part.min_count),
    requiredSubjectIds: [...part.required_subject_ids],
    grades: part.grade_percentages.map((entry) => row(entry.grade, String(entry.percentage))),
    mode: part.conversion?.mode ?? "table",
    bands: (part.conversion?.bands ?? []).map((band) =>
      row(String(band.min), String(band.percentage)),
    ),
    slope: text(part.conversion?.slope ?? null),
    intercept: text(part.conversion?.intercept ?? null),
    requireAwarded: part.require_awarded,
    gpaBasis: part.gpa_basis ?? "gpa",
  };
}

function draftFrom(set: EquivalencyRuleSet | null): SetDraft {
  if (!set) {
    return {
      name: "",
      sourceSystem: "igcse_a_level",
      gradeLevelIds: [],
      isActive: true,
      visible: false,
      parts: [blankPart()],
    };
  }
  return {
    name: set.name,
    sourceSystem: set.source_system,
    gradeLevelIds: set.grade_levels.map((grade) => grade.id),
    isActive: set.is_active,
    visible: set.visible_to_students_and_parents,
    parts: set.parts.map(partDraft),
  };
}

const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value));
const numberOrNaN = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

/** The part as the API and the grading engine see it, so the form checks exactly what the API will. */
function partOf(draft: PartDraft): EquivalencyPart {
  const subjects = draft.type === "exam_subjects";
  const converts = !subjects;
  return {
    type: draft.type,
    label: draft.label.trim(),
    weight: numberOrNaN(draft.weight),
    required: draft.required,
    exam_ids: draft.type === "exam_subjects" || draft.type === "exam_total" ? draft.examIds : [],
    best_count: subjects ? numberOrNull(draft.bestCount) : null,
    min_count: subjects ? numberOrNull(draft.minCount) : null,
    required_subject_ids: subjects ? draft.requiredSubjectIds : [],
    grade_percentages: subjects
      ? draft.grades
          .filter((entry) => entry.first.trim() !== "" || entry.percentage.trim() !== "")
          .map((entry) => ({
            grade: entry.first.trim(),
            percentage: numberOrNaN(entry.percentage),
          }))
      : [],
    conversion: converts
      ? {
          mode: draft.mode,
          bands:
            draft.mode === "table"
              ? draft.bands
                  .filter((band) => band.first.trim() !== "" || band.percentage.trim() !== "")
                  .map((band) => ({
                    min: numberOrNaN(band.first),
                    percentage: numberOrNaN(band.percentage),
                  }))
              : [],
          slope: draft.mode === "linear" ? numberOrNaN(draft.slope) : null,
          intercept: draft.mode === "linear" ? numberOrNaN(draft.intercept) : null,
        }
      : null,
    require_awarded: draft.type === "diploma_total" && draft.requireAwarded,
    gpa_basis: draft.type === "gpa" ? draft.gpaBasis : null,
  };
}

function definitionOf(part: EquivalencyPart): EquivalencyPartDefinition {
  return {
    type: part.type,
    label: part.label,
    weight: part.weight,
    required: part.required,
    examIds: [...part.exam_ids],
    bestCount: part.best_count,
    minCount: part.min_count,
    requiredSubjectIds: [...part.required_subject_ids],
    gradePercentages: part.grade_percentages.map((entry) => ({ ...entry })),
    conversion: part.conversion
      ? {
          ...part.conversion,
          bands: part.conversion.bands.map((band) => ({ ...band })),
        }
      : null,
    requireAwarded: part.require_awarded,
    gpaBasis: part.gpa_basis,
  };
}

function bodyOf(draft: SetDraft): EquivalencyRuleSetBody {
  return {
    name: draft.name.trim(),
    source_system: draft.sourceSystem,
    grade_level_ids: draft.gradeLevelIds,
    is_active: draft.isActive,
    visible_to_students_and_parents: draft.visible,
    parts: draft.parts.map(partOf),
  };
}

/**
 * Tawjihi equivalency: the school's own rules for ESTIMATING the Tawjihi-equivalent percentage of an
 * IGCSE / A Level, IB or American record (not tied to the selected year). Leadership edits the
 * rule sets, starting from clearly labelled examples, and lists a grade's estimates with a CSV
 * export. Every figure is an estimate the school confirms, not an official Ministry conversion.
 */
export function EquivalencyTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const canEdit = ctx.can.manage;
  const sets = useEquivalencyRuleSets();
  const remove = useDeleteEquivalencyRuleSet();
  const [editing, setEditing] = useState<{ set: EquivalencyRuleSet | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<EquivalencyRuleSet | null>(null);

  if (editing) {
    return (
      <EquivalencySetEditor
        set={editing.set}
        readOnly={!canEdit}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <>
      <section className="ag-block" aria-labelledby="ag-equivalency-heading">
        <div className="ag-head">
          <h2 id="ag-equivalency-heading">{t("academicGrading.equivalency.heading")}</h2>
          {canEdit ? (
            <Button type="button" variant="secondary" onClick={() => setEditing({ set: null })}>
              {t("academicGrading.equivalency.add")}
            </Button>
          ) : null}
        </div>
        <p className="ag-muted">{t("academicGrading.equivalency.help")}</p>
        <EstimateNotice />
        <Table caption={t("academicGrading.equivalency.caption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("academicGrading.equivalency.columns.name")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.equivalency.columns.grades")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.equivalency.columns.parts")}</Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.equivalency.columns.actions")}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={4}
            loading={sets.isPending}
            empty={
              sets.isError ? problemMessage(sets.error, t) : t("academicGrading.equivalency.empty")
            }
          >
            {(sets.data ?? []).map((set) => (
              <Table.Row key={set.id}>
                <Table.Cell>
                  <strong>{set.name}</strong>{" "}
                  <span className="ag-muted">
                    {t(`academicGrading.equivalency.sourceSystem.${set.source_system}`)}
                  </span>
                  <div>
                    {set.is_active ? null : (
                      <Badge tone="neutral">{t("academicGrading.equivalency.inactive")}</Badge>
                    )}{" "}
                    {set.visible_to_students_and_parents ? (
                      <Badge tone="info">{t("academicGrading.equivalency.visible")}</Badge>
                    ) : null}
                  </div>
                </Table.Cell>
                <Table.Cell>{set.grade_levels.map((grade) => grade.name).join(", ")}</Table.Cell>
                <Table.Cell>
                  {set.parts.map((part) => `${part.label} (${part.weight})`).join(" · ")}
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={t("academicGrading.equivalency.editLabel", { name: set.name })}
                      onClick={() => setEditing({ set })}
                    >
                      {canEdit
                        ? t("academicGrading.common.edit")
                        : t("academicGrading.common.view")}
                    </Button>
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("academicGrading.equivalency.deleteLabel", {
                          name: set.name,
                        })}
                        onClick={() => setPendingDelete(set)}
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
          title={t("academicGrading.equivalency.deleteTitle", { name: pendingDelete?.name ?? "" })}
          description={t("academicGrading.equivalency.deleteDescription")}
          confirmLabel={t("academicGrading.common.remove")}
          submitting={remove.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() =>
            pendingDelete &&
            remove.mutate(pendingDelete.id, {
              onSuccess: () => {
                show({ variant: "success", title: t("academicGrading.equivalency.deleted") });
                setPendingDelete(null);
              },
              onError: (error) => {
                show({
                  variant: "error",
                  title: t("academicGrading.equivalency.deleteFailed"),
                  description: problemMessage(error, t),
                });
                setPendingDelete(null);
              },
            })
          }
        />
      </section>
      {canEdit && (sets.data ?? []).length > 0 ? (
        <EquivalencyGradeList ctx={ctx} sets={sets.data ?? []} />
      ) : null}
    </>
  );
}

/** Every student of a grade in the selected year, estimated under one set, with a CSV export. */
function EquivalencyGradeList({
  ctx,
  sets,
}: {
  ctx: SetupContext;
  sets: readonly EquivalencyRuleSet[];
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const grades = useGradeLevels();
  const [setId, setSetId] = useState<string | undefined>(sets[0]?.id);
  const [gradeLevelId, setGradeLevelId] = useState<string | undefined>(undefined);
  const list = useEquivalencyStudentList(
    setId,
    gradeLevelId ? ctx.year.id : undefined,
    gradeLevelId,
  );
  const set = sets.find((candidate) => candidate.id === setId);
  const format = (value: number) => formatNumber(value, { maximumFractionDigits: 2 });
  const percent = (value: number | null) => (value === null ? "—" : `${format(value)}%`);
  const students = list.data?.students ?? [];

  function exportCsv() {
    if (!set || !list.data) return;
    const header = [
      t("academicGrading.equivalency.list.columns.admission"),
      t("academicGrading.equivalency.list.columns.firstName"),
      t("academicGrading.equivalency.list.columns.lastName"),
      t("academicGrading.equivalency.list.columns.section"),
      t("academicGrading.equivalency.list.columns.status"),
      t("academicGrading.equivalency.list.columns.estimate"),
      ...set.parts.map((part) => part.label),
      t("academicGrading.equivalency.list.columns.reasons"),
    ];
    const rows = students.map((student) => [
      student.admission_number,
      student.first_name,
      student.last_name,
      student.section_name,
      t(`academicGrading.equivalency.status.${student.status}`),
      student.percentage,
      ...set.parts.map((_, index) => student.parts.at(index)?.percentage ?? null),
      student.issues
        .filter((issue) => issue.kind !== "note")
        .map((issue) => equivalencyIssueText(issue, student.parts, t, format))
        .join("; "),
    ]);
    const grade = (grades.data ?? []).find((candidate) => candidate.id === gradeLevelId);
    const slug = `${set.name}-${grade?.name ?? "grade"}-${ctx.year.name}`
      .toLowerCase()
      .replace(/[^a-z0-9؀-ۿ]+/g, "-")
      .replace(/^-|-$/g, "");
    downloadCsv(`${slug || "equivalency"}-estimates.csv`, buildCsv(header, rows));
  }

  return (
    <section className="ag-block" aria-labelledby="ag-equivalency-list-heading">
      <h2 id="ag-equivalency-list-heading">{t("academicGrading.equivalency.list.heading")}</h2>
      <p className="ag-muted">
        {t("academicGrading.equivalency.list.help", { year: ctx.year.name })}
      </p>
      <div className="ag-row ag-grid ag-grid--dense">
        <Select
          label={t("academicGrading.equivalency.list.set")}
          options={sets.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
          value={setId}
          onChange={setSetId}
        />
        <Select
          label={t("academicGrading.equivalency.list.grade")}
          placeholder={t("academicGrading.equivalency.list.gradePlaceholder")}
          options={(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name }))}
          value={gradeLevelId}
          disabled={grades.isPending}
          onChange={setGradeLevelId}
        />
      </div>
      {setId && gradeLevelId ? (
        <QueryState isPending={list.isPending} error={list.error}>
          {list.data && !list.data.applies_to_grade_level ? (
            <p className="ag-notice" role="note">
              {t("academicGrading.equivalency.list.notForGrade")}
            </p>
          ) : null}
          <div className="ag-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={students.length === 0}
              onClick={exportCsv}
            >
              {t("academicGrading.equivalency.list.export")}
            </Button>
          </div>
          <Table caption={t("academicGrading.equivalency.list.caption")} hideCaption>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>
                  {t("academicGrading.equivalency.list.columns.student")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.equivalency.list.columns.section")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.equivalency.list.columns.estimate")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.equivalency.list.columns.reasons")}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body columnCount={4} empty={t("academicGrading.equivalency.list.empty")}>
              {students.map((student) => (
                <Table.Row key={student.student_id}>
                  <Table.Cell>
                    <strong>
                      {student.first_name} {student.last_name}
                    </strong>{" "}
                    <span className="ag-muted">{student.admission_number}</span>
                  </Table.Cell>
                  <Table.Cell>{student.section_name}</Table.Cell>
                  <Table.Cell>
                    <EquivalencyStatusBadge status={student.status} />{" "}
                    {student.percentage === null ? null : (
                      <strong>{percent(student.percentage)}</strong>
                    )}
                  </Table.Cell>
                  <Table.Cell>
                    {student.issues
                      .filter((issue) => issue.kind !== "note")
                      .map((issue) => equivalencyIssueText(issue, student.parts, t, format))
                      .join(" · ") || "—"}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </QueryState>
      ) : null}
    </section>
  );
}

function EquivalencySetEditor({
  set,
  readOnly,
  onClose,
}: {
  set: EquivalencyRuleSet | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveEquivalencyRuleSet();
  const grades = useGradeLevels();
  const subjects = useSubjects();
  const exams = useExternalExams(false);
  const [draft, setDraft] = useState<SetDraft>(() => draftFrom(set));
  const [example, setExample] = useState<EquivalencySourceSystem | undefined>(undefined);

  const issues = useMemo(() => {
    const found: (ValidationIssue & { key: string })[] = [];
    if (draft.name.trim() === "") {
      found.push({
        key: "name",
        code: "NAME",
        severity: "error",
        message: t("academicGrading.equivalency.nameRequired"),
      });
    }
    if (draft.gradeLevelIds.length === 0) {
      found.push({
        key: "grades",
        code: "GRADES",
        severity: "error",
        message: t("academicGrading.equivalency.gradesRequired"),
      });
    }
    validateEquivalencyParts(draft.parts.map(partOf).map(definitionOf)).forEach((issue, index) =>
      found.push({ ...issue, key: `${issue.code}-${index}` }),
    );
    return found;
  }, [draft, t]);

  const patch = (changes: Partial<SetDraft>) => setDraft((prev) => ({ ...prev, ...changes }));
  const patchPart = (key: string, changes: Partial<PartDraft>) =>
    setDraft((prev) => ({
      ...prev,
      parts: prev.parts.map((part) => (part.key === key ? { ...part, ...changes } : part)),
    }));
  const toggle = (list: readonly string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((candidate) => candidate !== id);

  /** Replace the parts with an example's, picking the catalogue exams its presets match. */
  function applyExample(sourceSystem: EquivalencySourceSystem) {
    const chosen = EQUIVALENCY_EXAMPLES.find(
      (candidate) => candidate.sourceSystem === sourceSystem,
    );
    if (!chosen) return;
    const catalogue = exams.data ?? [];
    setDraft((prev) => ({
      ...prev,
      sourceSystem,
      parts: chosen.parts.map((part) =>
        partDraft({
          type: part.type,
          label: part.label,
          weight: part.weight,
          required: part.required,
          exam_ids: catalogue
            .filter(
              (exam) => exam.preset_key !== null && part.examPresetKeys.includes(exam.preset_key),
            )
            .map((exam) => exam.id)
            .slice(0, part.type === "exam_total" ? 1 : undefined),
          best_count: part.bestCount,
          min_count: part.minCount,
          required_subject_ids: [],
          grade_percentages: part.gradePercentages,
          conversion: part.conversion,
          require_awarded: part.requireAwarded,
          gpa_basis: part.gpaBasis,
        }),
      ),
    }));
    setExample(sourceSystem);
  }

  function submit() {
    save.mutate(
      { setId: set?.id ?? null, body: bodyOf(draft) },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.equivalency.saved") });
          onClose();
        },
      },
    );
  }

  const rowEditor = (
    part: PartDraft,
    field: "grades" | "bands",
    firstLabel: string,
    index: number,
  ) => {
    const rows = field === "grades" ? part.grades : part.bands;
    const setRows = (next: RowDraft[]) =>
      patchPart(part.key, field === "grades" ? { grades: next } : { bands: next });
    return (
      <div
        className="ag-row"
        role="group"
        aria-label={t(`academicGrading.equivalency.${field}Label`, { n: index + 1 })}
      >
        {rows.map((entry, rowIndex) => (
          <div key={entry.key} className="ag-grid ag-grid--dense">
            <Input
              label={`${firstLabel} ${rowIndex + 1}`}
              value={entry.first}
              maxLength={20}
              type={field === "bands" ? "number" : "text"}
              step="any"
              onChange={(event) =>
                setRows(
                  rows.map((candidate) =>
                    candidate.key === entry.key
                      ? { ...candidate, first: event.target.value }
                      : candidate,
                  ),
                )
              }
            />
            <Input
              label={t("academicGrading.equivalency.percentageN", { n: rowIndex + 1 })}
              type="number"
              min={0}
              max={100}
              step="any"
              value={entry.percentage}
              onChange={(event) =>
                setRows(
                  rows.map((candidate) =>
                    candidate.key === entry.key
                      ? { ...candidate, percentage: event.target.value }
                      : candidate,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="tertiary"
              aria-label={t("academicGrading.equivalency.removeRow", { n: rowIndex + 1 })}
              onClick={() => setRows(rows.filter((candidate) => candidate.key !== entry.key))}
            >
              {t("academicGrading.common.remove")}
            </Button>
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={() => setRows([...rows, row("", "")])}>
          {t("academicGrading.equivalency.addRow")}
        </Button>
      </div>
    );
  };

  return (
    <section className="ag-editor" aria-labelledby="ag-equivalency-editor-heading">
      <div className="ag-head">
        <h2 id="ag-equivalency-editor-heading">
          {set
            ? t("academicGrading.equivalency.editTitle", { name: set.name })
            : t("academicGrading.equivalency.add")}
        </h2>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
      </div>
      <EstimateNotice />
      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.equivalency.details")}</legend>
        <div className="ag-grid ag-grid--dense">
          <Input
            label={t("academicGrading.equivalency.name")}
            value={draft.name}
            required
            maxLength={120}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <Select<EquivalencySourceSystem>
            label={t("academicGrading.equivalency.sourceSystemLabel")}
            options={EQUIVALENCY_SOURCE_SYSTEMS.map((system) => ({
              value: system,
              label: t(`academicGrading.equivalency.sourceSystem.${system}`),
            }))}
            value={draft.sourceSystem}
            onChange={(sourceSystem) => patch({ sourceSystem })}
          />
          {readOnly ? null : (
            <Select<EquivalencySourceSystem>
              label={t("academicGrading.equivalency.exampleLabel")}
              placeholder={t("academicGrading.equivalency.examplePlaceholder")}
              options={EQUIVALENCY_EXAMPLES.map((candidate) => ({
                value: candidate.sourceSystem,
                label: t("academicGrading.equivalency.exampleOption", {
                  system: t(`academicGrading.equivalency.sourceSystem.${candidate.sourceSystem}`),
                }),
              }))}
              value={example}
              disabled={exams.isPending}
              onChange={applyExample}
            />
          )}
        </div>
        {example ? (
          <p className="ag-notice" role="note">
            {t("academicGrading.equivalency.exampleNotice")}
          </p>
        ) : null}
        <Checkbox
          label={t("academicGrading.equivalency.activeLabel")}
          checked={draft.isActive}
          onChange={(event) => patch({ isActive: event.target.checked })}
        />
        <Checkbox
          label={t("academicGrading.equivalency.visibleLabel")}
          checked={draft.visible}
          onChange={(event) => patch({ visible: event.target.checked })}
        />
      </fieldset>

      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.equivalency.gradesLegend")}</legend>
        <div className="ag-checks">
          {(grades.data ?? []).map((grade) => (
            <Checkbox
              key={grade.id}
              label={grade.name}
              checked={draft.gradeLevelIds.includes(grade.id)}
              onChange={(event) =>
                patch({
                  gradeLevelIds: toggle(draft.gradeLevelIds, grade.id, event.target.checked),
                })
              }
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.equivalency.partsLegend")}</legend>
        <p className="ag-muted">{t("academicGrading.equivalency.partsHelp")}</p>
        {draft.parts.map((part, index) => (
          <div
            key={part.key}
            className="ag-row"
            role="group"
            aria-label={t("academicGrading.equivalency.partN", { n: index + 1 })}
          >
            <div className="ag-grid ag-grid--dense">
              <Select<EquivalencyPartType>
                label={t("academicGrading.equivalency.partTypeLabel")}
                options={EQUIVALENCY_PART_TYPES.map((type) => ({
                  value: type,
                  label: t(`academicGrading.equivalency.partType.${type}`),
                }))}
                value={part.type}
                onChange={(type) =>
                  patchPart(part.key, {
                    type,
                    examIds: [],
                    requireAwarded: type === "diploma_total",
                  })
                }
              />
              <Input
                label={t("academicGrading.equivalency.partLabel")}
                value={part.label}
                required
                maxLength={80}
                onChange={(event) => patchPart(part.key, { label: event.target.value })}
              />
              <Input
                label={t("academicGrading.equivalency.weight")}
                helperText={t("academicGrading.equivalency.weightHelp")}
                type="number"
                min={0}
                max={100}
                step="any"
                value={part.weight}
                onChange={(event) => patchPart(part.key, { weight: event.target.value })}
              />
              {part.type === "exam_total" ? (
                <Select
                  label={t("academicGrading.equivalency.exam")}
                  placeholder={t("academicGrading.equivalency.examPlaceholder")}
                  options={(exams.data ?? []).map((exam) => ({ value: exam.id, label: exam.name }))}
                  value={part.examIds[0]}
                  disabled={exams.isPending}
                  onChange={(examId) => patchPart(part.key, { examIds: [examId] })}
                />
              ) : null}
              {part.type === "gpa" ? (
                <Select<GpaBasis>
                  label={t("academicGrading.equivalency.gpaBasisLabel")}
                  options={(["gpa", "weighted_gpa"] as const).map((basis) => ({
                    value: basis,
                    label: t(`academicGrading.equivalency.gpaBasis.${basis}`),
                  }))}
                  value={part.gpaBasis}
                  onChange={(gpaBasis) => patchPart(part.key, { gpaBasis })}
                />
              ) : null}
              {part.type === "exam_subjects" ? (
                <>
                  <Input
                    label={t("academicGrading.equivalency.bestCount")}
                    helperText={t("academicGrading.equivalency.bestCountHelp")}
                    type="number"
                    min={1}
                    max={20}
                    value={part.bestCount}
                    onChange={(event) => patchPart(part.key, { bestCount: event.target.value })}
                  />
                  <Input
                    label={t("academicGrading.equivalency.minCount")}
                    helperText={t("academicGrading.equivalency.minCountHelp")}
                    type="number"
                    min={1}
                    max={20}
                    value={part.minCount}
                    onChange={(event) => patchPart(part.key, { minCount: event.target.value })}
                  />
                </>
              ) : null}
            </div>
            <Checkbox
              label={t("academicGrading.equivalency.requiredLabel")}
              checked={part.required}
              onChange={(event) => patchPart(part.key, { required: event.target.checked })}
            />
            {part.type === "diploma_total" ? (
              <Checkbox
                label={t("academicGrading.equivalency.requireAwardedLabel")}
                checked={part.requireAwarded}
                onChange={(event) => patchPart(part.key, { requireAwarded: event.target.checked })}
              />
            ) : null}
            {part.type === "exam_subjects" ? (
              <>
                <div
                  className="ag-checks"
                  role="group"
                  aria-label={t("academicGrading.equivalency.examsLabel", { n: index + 1 })}
                >
                  {(exams.data ?? []).map((exam) => (
                    <Checkbox
                      key={exam.id}
                      label={`${exam.name} (${exam.code})`}
                      checked={part.examIds.includes(exam.id)}
                      onChange={(event) =>
                        patchPart(part.key, {
                          examIds: toggle(part.examIds, exam.id, event.target.checked),
                        })
                      }
                    />
                  ))}
                </div>
                <div
                  className="ag-checks ag-checks--scroll"
                  role="group"
                  aria-label={t("academicGrading.equivalency.requiredSubjectsLabel", {
                    n: index + 1,
                  })}
                >
                  {(subjects.data ?? []).map((subject) => (
                    <Checkbox
                      key={subject.id}
                      label={`${subject.name} (${subject.code})`}
                      checked={part.requiredSubjectIds.includes(subject.id)}
                      onChange={(event) =>
                        patchPart(part.key, {
                          requiredSubjectIds: toggle(
                            part.requiredSubjectIds,
                            subject.id,
                            event.target.checked,
                          ),
                        })
                      }
                    />
                  ))}
                </div>
                {rowEditor(part, "grades", t("academicGrading.equivalency.grade"), index)}
              </>
            ) : (
              <>
                <Select<ConversionMode>
                  label={t("academicGrading.equivalency.modeLabel")}
                  options={(["table", "linear"] as const).map((mode) => ({
                    value: mode,
                    label: t(`academicGrading.equivalency.mode.${mode}`),
                  }))}
                  value={part.mode}
                  onChange={(mode) => patchPart(part.key, { mode })}
                />
                {part.mode === "table" ? (
                  rowEditor(part, "bands", t("academicGrading.equivalency.bandMin"), index)
                ) : (
                  <div className="ag-grid ag-grid--dense">
                    <Input
                      label={t("academicGrading.equivalency.slope")}
                      type="number"
                      step="any"
                      value={part.slope}
                      onChange={(event) => patchPart(part.key, { slope: event.target.value })}
                    />
                    <Input
                      label={t("academicGrading.equivalency.intercept")}
                      helperText={t("academicGrading.equivalency.linearHelp")}
                      type="number"
                      step="any"
                      value={part.intercept}
                      onChange={(event) => patchPart(part.key, { intercept: event.target.value })}
                    />
                  </div>
                )}
              </>
            )}
            <div className="ag-row__actions">
              <Button
                type="button"
                variant="tertiary"
                aria-label={t("academicGrading.equivalency.removePart", { n: index + 1 })}
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    parts: prev.parts.filter((candidate) => candidate.key !== part.key),
                  }))
                }
              >
                {t("academicGrading.common.remove")}
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() => setDraft((prev) => ({ ...prev, parts: [...prev.parts, blankPart()] }))}
        >
          {t("academicGrading.equivalency.addPart")}
        </Button>
      </fieldset>

      <section className="ag-card ag-check" aria-label={t("academicGrading.editor.check")}>
        {issues.length === 0 ? (
          <p>{t("academicGrading.equivalency.valid")}</p>
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
          <Button
            type="button"
            loading={save.isPending}
            disabled={issues.length > 0}
            onClick={submit}
          >
            {t("academicGrading.equivalency.save")}
          </Button>
        )}
      </div>
    </section>
  );
}
