import { validateExternalExamDefinition } from "@studafy/grading-engine";
import { Button, Checkbox, Input, Select, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { Badge, ConfirmModal, SeverityBadge } from "./components";
import { newKey } from "./config-form";
import { problemMessage } from "./errors";
import {
  useAddExternalExamFromPreset,
  useExternalExamPresets,
  useExternalExams,
  useSaveExternalExam,
  useSetExternalExamArchived,
} from "./external-exams";

import type { SetupContext } from "./context";
import type { ExternalExam, ExternalExamBody, ExternalExamPresetKey } from "./external-exams";
import type { ExternalExamDefinition, ExternalExamTotalMode } from "@studafy/grading-engine";

interface ComponentDraft {
  key: string;
  id: string | undefined;
  name: string;
  scoreType: "numeric" | "label";
  min: string;
  max: string;
  step: string;
  /** Allowed grades, best first, comma-separated as typed. */
  labels: string;
  /** Results are scored in it: how it is scored can no longer change. */
  locked: boolean;
}

interface ExamDraft {
  code: string;
  name: string;
  totalMode: ExternalExamTotalMode;
  roundingStep: string;
  totalMin: string;
  totalMax: string;
  perSubject: boolean;
  showOnTranscript: boolean;
  components: ComponentDraft[];
}

const TOTAL_MODES: readonly ExternalExamTotalMode[] = ["sum", "average", "none"];

const numberOrNull = (value: string): number | null =>
  value.trim() === "" ? null : Number(value.trim());

const splitLabels = (value: string): string[] =>
  value
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");

function blankComponent(): ComponentDraft {
  return {
    key: newKey("component"),
    id: undefined,
    name: "",
    scoreType: "numeric",
    min: "0",
    max: "100",
    step: "1",
    labels: "",
    locked: false,
  };
}

function draftFrom(exam: ExternalExam | null): ExamDraft {
  if (!exam) {
    return {
      code: "",
      name: "",
      totalMode: "none",
      roundingStep: "",
      totalMin: "",
      totalMax: "",
      perSubject: false,
      showOnTranscript: true,
      components: [blankComponent()],
    };
  }
  const text = (value: number | null) => (value === null ? "" : String(value));
  return {
    code: exam.code,
    name: exam.name,
    totalMode: exam.total_mode,
    roundingStep: text(exam.total_rounding_step),
    totalMin: text(exam.total_min),
    totalMax: text(exam.total_max),
    perSubject: exam.per_subject,
    showOnTranscript: exam.show_on_transcript,
    components: exam.components.map((component) => ({
      key: newKey("component"),
      id: component.id,
      name: component.name,
      scoreType: component.score_type,
      min: text(component.min_score),
      max: text(component.max_score),
      step: text(component.step),
      labels: (component.allowed_labels ?? []).join(", "),
      locked: component.has_scores,
    })),
  };
}

/** The draft as the grading engine sees it, so the form checks exactly what the API will. */
function definitionOf(draft: ExamDraft): ExternalExamDefinition {
  const withTotal = draft.totalMode !== "none";
  return {
    code: draft.code.trim(),
    name: draft.name.trim(),
    totalMode: draft.totalMode,
    totalRoundingStep: draft.totalMode === "average" ? numberOrNull(draft.roundingStep) : null,
    totalMin: withTotal ? numberOrNull(draft.totalMin) : null,
    totalMax: withTotal ? numberOrNull(draft.totalMax) : null,
    perSubject: draft.perSubject,
    showOnTranscript: draft.showOnTranscript,
    components: draft.components.map((component) => {
      const numeric = component.scoreType === "numeric";
      return {
        name: component.name.trim(),
        scoreType: component.scoreType,
        minScore: numeric ? numberOrNull(component.min) : null,
        maxScore: numeric ? numberOrNull(component.max) : null,
        step: numeric ? numberOrNull(component.step) : null,
        allowedLabels: numeric ? null : splitLabels(component.labels),
      };
    }),
  };
}

function bodyOf(draft: ExamDraft): ExternalExamBody {
  const definition = definitionOf(draft);
  return {
    code: definition.code,
    name: definition.name,
    total_mode: definition.totalMode,
    total_rounding_step: definition.totalRoundingStep,
    total_min: definition.totalMin,
    total_max: definition.totalMax,
    per_subject: definition.perSubject,
    show_on_transcript: definition.showOnTranscript,
    components: definition.components.map((component, index) => ({
      ...(draft.components[index]?.id ? { id: draft.components[index].id } : {}),
      name: component.name,
      score_type: component.scoreType,
      min_score: component.minScore,
      max_score: component.maxScore,
      step: component.step,
      allowed_labels: component.allowedLabels,
    })),
  };
}

/**
 * The school's external exams (SAT, IELTS, IGCSE finals...): added from a built-in preset or
 * defined from scratch, then edited or archived. Not tied to the selected academic year. Once
 * results are recorded, the API locks how an exam is scored; the form shows those fields read-only.
 */
export function ExternalExamsTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const canEdit = ctx.can.manage;
  const [showArchived, setShowArchived] = useState(false);
  const exams = useExternalExams(showArchived);
  const presets = useExternalExamPresets(canEdit);
  const addPreset = useAddExternalExamFromPreset();
  const archive = useSetExternalExamArchived();
  const [preset, setPreset] = useState<ExternalExamPresetKey | undefined>(undefined);
  const [editing, setEditing] = useState<{ exam: ExternalExam | null } | null>(null);
  const [pendingArchive, setPendingArchive] = useState<ExternalExam | null>(null);

  if (editing) {
    return (
      <ExternalExamEditor
        exam={editing.exam}
        readOnly={!canEdit}
        onClose={() => setEditing(null)}
      />
    );
  }

  // Preset names and notes in the viewer's language (Tawjihi is "التوجيهي" in Arabic); the exam is
  // added under that name, which the school can still change.
  const presetName = (key: ExternalExamPresetKey, fallback: string) =>
    t(`academicGrading.externalExams.presets.${key}.name`, { defaultValue: fallback });
  const chosen = presets.data?.find((candidate) => candidate.key === preset);

  function addFromPreset() {
    if (!preset || !chosen) return;
    addPreset.mutate(
      { preset_key: preset, name: presetName(chosen.key, chosen.name) },
      {
        onSuccess: (exam) => {
          show({
            variant: "success",
            title: t("academicGrading.externalExams.added", { name: exam.name }),
          });
          setPreset(undefined);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.externalExams.addFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  function restore(exam: ExternalExam) {
    archive.mutate(
      { examId: exam.id, archived: false },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("academicGrading.externalExams.restored") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.externalExams.archiveFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  const total = (exam: ExternalExam) =>
    exam.total_mode === "none"
      ? t("academicGrading.externalExams.totalMode.none")
      : exam.total_min !== null && exam.total_max !== null
        ? t("academicGrading.externalExams.totalRange", {
            mode: t(`academicGrading.externalExams.totalMode.${exam.total_mode}`),
            min: formatNumber(exam.total_min),
            max: formatNumber(exam.total_max),
          })
        : t(`academicGrading.externalExams.totalMode.${exam.total_mode}`);

  return (
    <section className="ag-block" aria-labelledby="ag-external-exams-heading">
      <div className="ag-head">
        <h2 id="ag-external-exams-heading">{t("academicGrading.externalExams.heading")}</h2>
        {canEdit ? (
          <Button type="button" variant="secondary" onClick={() => setEditing({ exam: null })}>
            {t("academicGrading.externalExams.addCustom")}
          </Button>
        ) : null}
      </div>
      <p className="ag-muted">{t("academicGrading.externalExams.help")}</p>
      {canEdit ? (
        <div className="ag-row ag-grid ag-grid--dense">
          <Select<ExternalExamPresetKey>
            label={t("academicGrading.externalExams.preset")}
            placeholder={t("academicGrading.externalExams.presetPlaceholder")}
            options={(presets.data ?? []).map((candidate) => ({
              value: candidate.key,
              label: presetName(candidate.key, candidate.name),
            }))}
            value={preset}
            onChange={setPreset}
            disabled={presets.isPending}
          />
          <div className="ag-row__actions">
            <Button
              type="button"
              loading={addPreset.isPending}
              disabled={!preset}
              onClick={addFromPreset}
            >
              {t("academicGrading.externalExams.addPreset")}
            </Button>
          </div>
        </div>
      ) : null}
      {canEdit && chosen?.note ? (
        <p className="ag-notice" role="note">
          {t(`academicGrading.externalExams.presets.${chosen.key}.note`, {
            defaultValue: chosen.note,
          })}
        </p>
      ) : null}
      <Checkbox
        label={t("academicGrading.externalExams.showArchived")}
        checked={showArchived}
        onChange={(event) => setShowArchived(event.target.checked)}
      />
      <Table caption={t("academicGrading.externalExams.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.externalExams.columns.name")}</Table.HeaderCell>
            <Table.HeaderCell>
              {t("academicGrading.externalExams.columns.components")}
            </Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.externalExams.columns.total")}</Table.HeaderCell>
            <Table.HeaderCell>
              {t("academicGrading.externalExams.columns.results")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("academicGrading.externalExams.columns.actions")}
            </Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={5}
          loading={exams.isPending}
          empty={
            exams.isError
              ? problemMessage(exams.error, t)
              : t("academicGrading.externalExams.empty")
          }
        >
          {(exams.data ?? []).map((exam) => (
            <Table.Row key={exam.id}>
              <Table.Cell>
                <strong>{exam.name}</strong> <span className="ag-muted">{exam.code}</span>
                <div>
                  {exam.per_subject ? (
                    <Badge tone="info">{t("academicGrading.externalExams.perSubject")}</Badge>
                  ) : null}{" "}
                  {exam.show_on_transcript ? (
                    <Badge tone="success">{t("academicGrading.externalExams.onTranscript")}</Badge>
                  ) : null}{" "}
                  {exam.archived_at ? (
                    <Badge tone="neutral">{t("academicGrading.externalExams.archived")}</Badge>
                  ) : null}
                </div>
              </Table.Cell>
              <Table.Cell>
                {exam.components
                  .map((component) =>
                    component.score_type === "numeric"
                      ? t("academicGrading.externalExams.numericSummary", {
                          name: component.name,
                          min: formatNumber(component.min_score ?? 0),
                          max: formatNumber(component.max_score ?? 0),
                        })
                      : t("academicGrading.externalExams.labelSummary", {
                          name: component.name,
                          labels: (component.allowed_labels ?? []).join(" "),
                        }),
                  )
                  .join(" · ")}
              </Table.Cell>
              <Table.Cell>{total(exam)}</Table.Cell>
              <Table.Cell>{formatNumber(exam.result_count)}</Table.Cell>
              <Table.Cell>
                <div className="sections-page__row-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={t("academicGrading.externalExams.editLabel", { name: exam.name })}
                    onClick={() => setEditing({ exam })}
                  >
                    {canEdit ? t("academicGrading.common.edit") : t("academicGrading.common.view")}
                  </Button>
                  {canEdit ? (
                    exam.archived_at ? (
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("academicGrading.externalExams.restoreLabel", {
                          name: exam.name,
                        })}
                        onClick={() => restore(exam)}
                      >
                        {t("academicGrading.externalExams.restore")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("academicGrading.externalExams.archiveLabel", {
                          name: exam.name,
                        })}
                        onClick={() => setPendingArchive(exam)}
                      >
                        {t("academicGrading.externalExams.archive")}
                      </Button>
                    )
                  ) : null}
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      <ConfirmModal
        open={pendingArchive !== null}
        title={t("academicGrading.externalExams.archiveTitle", {
          name: pendingArchive?.name ?? "",
        })}
        description={t("academicGrading.externalExams.archiveDescription")}
        confirmLabel={t("academicGrading.externalExams.archive")}
        submitting={archive.isPending}
        onCancel={() => setPendingArchive(null)}
        onConfirm={() =>
          pendingArchive &&
          archive.mutate(
            { examId: pendingArchive.id, archived: true },
            {
              onSuccess: () => {
                show({
                  variant: "success",
                  title: t("academicGrading.externalExams.archivedToast"),
                });
                setPendingArchive(null);
              },
              onError: (error) => {
                show({
                  variant: "error",
                  title: t("academicGrading.externalExams.archiveFailed"),
                  description: problemMessage(error, t),
                });
                setPendingArchive(null);
              },
            },
          )
        }
      />
    </section>
  );
}

function ExternalExamEditor({
  exam,
  readOnly,
  onClose,
}: {
  exam: ExternalExam | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveExternalExam();
  const [draft, setDraft] = useState<ExamDraft>(() => draftFrom(exam));
  const hasResults = (exam?.result_count ?? 0) > 0;
  const issues = useMemo(() => validateExternalExamDefinition(definitionOf(draft)), [draft]);

  const patch = (changes: Partial<ExamDraft>) => setDraft((prev) => ({ ...prev, ...changes }));
  const patchComponent = (key: string, changes: Partial<ComponentDraft>) =>
    setDraft((prev) => ({
      ...prev,
      components: prev.components.map((component) =>
        component.key === key ? { ...component, ...changes } : component,
      ),
    }));

  function submit() {
    save.mutate(
      { examId: exam?.id ?? null, body: bodyOf(draft) },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.externalExams.saved") });
          onClose();
        },
      },
    );
  }

  return (
    <section className="ag-editor" aria-labelledby="ag-external-exam-editor-heading">
      <div className="ag-head">
        <h2 id="ag-external-exam-editor-heading">
          {exam
            ? t("academicGrading.externalExams.editTitle", { name: exam.name })
            : t("academicGrading.externalExams.addCustom")}
        </h2>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
      </div>
      {hasResults && !readOnly ? (
        <p className="ag-notice" role="note">
          {t("academicGrading.externalExams.lockedNote")}
        </p>
      ) : null}
      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.externalExams.details")}</legend>
        <div className="ag-grid ag-grid--dense">
          <Input
            label={t("academicGrading.externalExams.name")}
            value={draft.name}
            required
            maxLength={120}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <Input
            label={t("academicGrading.externalExams.code")}
            value={draft.code}
            required
            maxLength={40}
            onChange={(event) => patch({ code: event.target.value })}
          />
          <Select<ExternalExamTotalMode>
            label={t("academicGrading.externalExams.total")}
            options={TOTAL_MODES.map((mode) => ({
              value: mode,
              label: t(`academicGrading.externalExams.totalMode.${mode}`),
            }))}
            value={draft.totalMode}
            onChange={(totalMode) => patch({ totalMode })}
            disabled={readOnly || hasResults}
          />
          {draft.totalMode === "average" ? (
            <Input
              label={t("academicGrading.externalExams.roundingStep")}
              type="number"
              min={0}
              step="any"
              value={draft.roundingStep}
              helperText={t("academicGrading.externalExams.roundingStepHelp")}
              disabled={readOnly || hasResults}
              onChange={(event) => patch({ roundingStep: event.target.value })}
            />
          ) : null}
          {draft.totalMode !== "none" ? (
            <>
              <Input
                label={t("academicGrading.externalExams.totalMin")}
                type="number"
                step="any"
                value={draft.totalMin}
                onChange={(event) => patch({ totalMin: event.target.value })}
              />
              <Input
                label={t("academicGrading.externalExams.totalMax")}
                type="number"
                step="any"
                value={draft.totalMax}
                onChange={(event) => patch({ totalMax: event.target.value })}
              />
            </>
          ) : null}
        </div>
        <Checkbox
          label={t("academicGrading.externalExams.perSubjectLabel")}
          checked={draft.perSubject}
          disabled={readOnly || hasResults}
          onChange={(event) => patch({ perSubject: event.target.checked })}
        />
        <Checkbox
          label={t("academicGrading.externalExams.onTranscriptLabel")}
          checked={draft.showOnTranscript}
          onChange={(event) => patch({ showOnTranscript: event.target.checked })}
        />
      </fieldset>

      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.externalExams.components")}</legend>
        <p className="ag-muted">{t("academicGrading.externalExams.componentsHelp")}</p>
        {draft.components.map((component, index) => (
          <div
            key={component.key}
            className="ag-row ag-grid ag-grid--dense"
            role="group"
            aria-label={t("academicGrading.externalExams.componentN", { n: index + 1 })}
          >
            <Input
              label={t("academicGrading.externalExams.componentName")}
              value={component.name}
              required
              maxLength={120}
              onChange={(event) => patchComponent(component.key, { name: event.target.value })}
            />
            <Select<"numeric" | "label">
              label={t("academicGrading.externalExams.scoreType")}
              options={(["numeric", "label"] as const).map((type) => ({
                value: type,
                label: t(`academicGrading.externalExams.scoreTypes.${type}`),
              }))}
              value={component.scoreType}
              disabled={readOnly || component.locked}
              onChange={(scoreType) => patchComponent(component.key, { scoreType })}
            />
            {component.scoreType === "numeric" ? (
              <>
                <Input
                  label={t("academicGrading.externalExams.min")}
                  type="number"
                  step="any"
                  value={component.min}
                  disabled={readOnly || component.locked}
                  onChange={(event) => patchComponent(component.key, { min: event.target.value })}
                />
                <Input
                  label={t("academicGrading.externalExams.max")}
                  type="number"
                  step="any"
                  value={component.max}
                  disabled={readOnly || component.locked}
                  onChange={(event) => patchComponent(component.key, { max: event.target.value })}
                />
                <Input
                  label={t("academicGrading.externalExams.step")}
                  type="number"
                  min={0}
                  step="any"
                  value={component.step}
                  disabled={readOnly || component.locked}
                  onChange={(event) => patchComponent(component.key, { step: event.target.value })}
                />
              </>
            ) : (
              <Input
                label={t("academicGrading.externalExams.labels")}
                helperText={t("academicGrading.externalExams.labelsHelp")}
                value={component.labels}
                disabled={readOnly || component.locked}
                onChange={(event) => patchComponent(component.key, { labels: event.target.value })}
              />
            )}
            <div className="ag-row__actions">
              <Button
                type="button"
                variant="tertiary"
                disabled={draft.components.length <= 1 || component.locked}
                aria-label={t("academicGrading.externalExams.removeComponent", { n: index + 1 })}
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    components: prev.components.filter((c) => c.key !== component.key),
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
          onClick={() =>
            setDraft((prev) => ({ ...prev, components: [...prev.components, blankComponent()] }))
          }
        >
          {t("academicGrading.externalExams.addComponent")}
        </Button>
      </fieldset>

      <section className="ag-card ag-check" aria-label={t("academicGrading.editor.check")}>
        {issues.length === 0 ? (
          <p>{t("academicGrading.externalExams.valid")}</p>
        ) : (
          <ul className="ag-issues">
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="ag-issues__item">
                <SeverityBadge severity={issue.severity} /> <span>{issue.message}</span>
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
            {t("academicGrading.externalExams.save")}
          </Button>
        )}
      </div>
    </section>
  );
}
