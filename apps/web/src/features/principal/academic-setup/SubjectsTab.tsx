import { Button, Checkbox, Input, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSubjects } from "../school/queries";
import { useGradeLevels } from "../sections/queries";

import { Badge, ConfirmModal, QueryState } from "./components";
import { ROUNDING_MODES } from "./config-form";
import { problemMessage } from "./errors";
import { useDeleteSubjectConfig, useSaveGradeProgram } from "./mutations";
import { useGradePrograms, useGradeScales, useGradeSubjectConfigs } from "./queries";
import { SubjectConfigEditor } from "./SubjectConfigEditor";

import type { RoundingMode } from "./config-form";
import type { SetupContext } from "./context";
import type { GradeProgram, GradeScale, SubjectConfig } from "./queries";
import type { EditorTarget } from "./SubjectConfigEditor";

/**
 * Per grade: the grade's policies for the year (default scale, mark approval, supplementary
 * threshold, average rounding) and its default subjects — the grading rules every section of the
 * grade inherits unless it overrides them.
 */
export function SubjectsTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const grades = useGradeLevels();
  const programs = useGradePrograms(ctx.year.id);
  const scales = useGradeScales(ctx.year.id);
  const [pickedGradeId, setPickedGradeId] = useState<string>();
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  const gradeList = grades.data ?? [];
  const grade = gradeList.find((g) => g.id === pickedGradeId) ?? gradeList[0];
  const program = programs.data?.find((p) => p.grade_level_id === grade?.id);

  if (editor) {
    return <SubjectConfigEditor ctx={ctx} target={editor} onClose={() => setEditor(null)} />;
  }

  return (
    <QueryState
      isPending={grades.isPending || programs.isPending || scales.isPending}
      error={grades.error ?? programs.error ?? scales.error}
      empty={gradeList.length === 0}
      emptyText={t("academicGrading.subjects.noGrades")}
    >
      <div className="principal-school__filters">
        <Select
          label={t("academicGrading.subjects.gradeLabel")}
          options={gradeList.map((g) => ({
            value: g.id,
            label: programs.data?.some((p) => p.grade_level_id === g.id)
              ? g.name
              : t("academicGrading.subjects.gradeNotSetUp", { name: g.name }),
          }))}
          value={grade?.id}
          onChange={setPickedGradeId}
        />
      </div>
      {grade ? (
        <>
          <ProgramForm
            key={`${grade.id}-${program?.updated_at ?? "new"}`}
            ctx={ctx}
            gradeLevelId={grade.id}
            gradeName={grade.name}
            program={program}
            scales={scales.data ?? []}
          />
          {program ? (
            <GradeSubjects
              ctx={ctx}
              gradeLevelId={grade.id}
              gradeName={grade.name}
              onEdit={setEditor}
            />
          ) : null}
        </>
      ) : null}
    </QueryState>
  );
}

function ProgramForm({
  ctx,
  gradeLevelId,
  gradeName,
  program,
  scales,
}: {
  ctx: SetupContext;
  gradeLevelId: string;
  gradeName: string;
  program: GradeProgram | undefined;
  scales: readonly GradeScale[];
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveGradeProgram();
  const [scaleId, setScaleId] = useState(program?.grade_scale_id ?? "");
  const [approval, setApproval] = useState(program?.mark_approval_required ?? false);
  const [maxFailed, setMaxFailed] = useState(
    String(program?.max_failed_subjects_for_supplementary ?? 2),
  );
  const [decimals, setDecimals] = useState(String(program?.average_rounding_decimals ?? 2));
  const [mode, setMode] = useState<RoundingMode>(program?.average_rounding_mode ?? "half_up");
  const disabled = !ctx.can.manage || !ctx.configEditable;

  function submit() {
    save.mutate(
      {
        yearId: ctx.year.id,
        gradeLevelId,
        body: {
          grade_scale_id: scaleId === "" ? null : scaleId,
          mark_approval_required: approval,
          max_failed_subjects_for_supplementary: Number(maxFailed),
          average_rounding_decimals: Number(decimals),
          average_rounding_mode: mode,
        },
      },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("academicGrading.subjects.program.saved") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.subjects.program.failed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <section className="ag-block ag-card" aria-labelledby="ag-program-heading">
      <h2 id="ag-program-heading">
        {t("academicGrading.subjects.program.heading", { grade: gradeName })}
      </h2>
      {program ? null : (
        <p className="ag-notice">{t("academicGrading.subjects.program.notSetUp")}</p>
      )}
      <fieldset className="ag-fieldset ag-fieldset--plain" disabled={disabled}>
        <legend className="sf-visually-hidden">
          {t("academicGrading.subjects.program.heading", { grade: gradeName })}
        </legend>
        <div className="ag-grid">
          <Select
            label={t("academicGrading.subjects.program.scale")}
            options={[
              { value: "", label: t("academicGrading.subjects.program.noScale") },
              ...scales.map((scale) => ({ value: scale.id, label: scale.name })),
            ]}
            value={scaleId}
            onChange={setScaleId}
            disabled={disabled}
          />
          <Input
            label={t("academicGrading.subjects.program.maxFailed")}
            helperText={t("academicGrading.subjects.program.maxFailedHelp")}
            type="number"
            min={0}
            max={50}
            value={maxFailed}
            onChange={(event) => setMaxFailed(event.target.value)}
          />
          <Input
            label={t("academicGrading.subjects.program.decimals")}
            type="number"
            min={0}
            max={4}
            value={decimals}
            onChange={(event) => setDecimals(event.target.value)}
          />
          <Select
            label={t("academicGrading.subjects.program.mode")}
            options={ROUNDING_MODES.map((value) => ({
              value,
              label: t(`academicGrading.rounding.${value}`),
            }))}
            value={mode}
            onChange={setMode}
            disabled={disabled}
          />
        </div>
        <Checkbox
          label={t("academicGrading.subjects.program.approval")}
          checked={approval}
          onChange={(event) => setApproval(event.target.checked)}
        />
      </fieldset>
      {disabled ? null : (
        <div className="ag-actions">
          <Button type="button" loading={save.isPending} onClick={submit}>
            {program
              ? t("academicGrading.subjects.program.save")
              : t("academicGrading.subjects.program.setUp")}
          </Button>
        </div>
      )}
    </section>
  );
}

function GradeSubjects({
  ctx,
  gradeLevelId,
  gradeName,
  onEdit,
}: {
  ctx: SetupContext;
  gradeLevelId: string;
  gradeName: string;
  onEdit: (target: EditorTarget) => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const configs = useGradeSubjectConfigs(ctx.year.id, gradeLevelId);
  const subjects = useSubjects(ctx.can.manage);
  const remove = useDeleteSubjectConfig();
  const [newSubjectId, setNewSubjectId] = useState<string>();
  const [pendingRemove, setPendingRemove] = useState<SubjectConfig | null>(null);
  const canEdit = ctx.can.manage && ctx.configEditable;

  // Grade defaults only; section-only subjects are listed on the Sections tab.
  const defaults = (configs.data ?? []).filter((config) => config.section_id === null);
  const configured = new Set(defaults.map((config) => config.subject.id));
  const available = (subjects.data ?? []).filter((subject) => !configured.has(subject.id));

  function confirmRemove() {
    if (!pendingRemove) return;
    remove.mutate(pendingRemove.id, {
      onSuccess: () => {
        show({ variant: "success", title: t("academicGrading.subjects.removed") });
        setPendingRemove(null);
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("academicGrading.subjects.removeFailed"),
          description: problemMessage(error, t),
        });
        setPendingRemove(null);
      },
    });
  }

  return (
    <section className="ag-block" aria-labelledby="ag-grade-subjects-heading">
      <div className="ag-head">
        <h2 id="ag-grade-subjects-heading">
          {t("academicGrading.subjects.heading", { grade: gradeName })}
        </h2>
      </div>
      <p className="ag-muted">{t("academicGrading.subjects.inheritHelp")}</p>
      {canEdit ? (
        <div className="principal-school__filters">
          <Select
            label={t("academicGrading.subjects.addLabel")}
            options={available.map((subject) => ({
              value: subject.id,
              label: `${subject.name} (${subject.code})`,
            }))}
            value={newSubjectId}
            onChange={setNewSubjectId}
            placeholder={
              subjects.isPending
                ? t("academicGrading.common.loading")
                : t("academicGrading.subjects.addPlaceholder")
            }
            disabled={available.length === 0}
          />
          <div className="principal-school__actions">
            <Button
              type="button"
              disabled={!newSubjectId}
              onClick={() => {
                const subject = available.find((s) => s.id === newSubjectId);
                if (!subject) return;
                onEdit({
                  kind: "create",
                  gradeLevelId,
                  sectionId: null,
                  subjectId: subject.id,
                  subjectName: subject.name,
                });
              }}
            >
              {t("academicGrading.subjects.add")}
            </Button>
          </div>
        </div>
      ) : null}
      <Table caption={t("academicGrading.subjects.caption", { grade: gradeName })} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.subjects.columns.subject")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.subjects.columns.requirement")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.subjects.columns.method")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.subjects.columns.weights")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.subjects.columns.validity")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.subjects.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={6}
          loading={configs.isPending}
          empty={
            configs.isError ? problemMessage(configs.error, t) : t("academicGrading.subjects.empty")
          }
        >
          {defaults.map((config) => {
            const errors = config.issues.filter((issue) => issue.severity === "error").length;
            const warnings = config.issues.length - errors;
            return (
              <Table.Row key={config.id}>
                <Table.Cell>
                  {config.subject.name} <span className="ag-muted">({config.subject.code})</span>
                </Table.Cell>
                <Table.Cell>{t(`academicGrading.requirement.${config.requirement}`)}</Table.Cell>
                <Table.Cell>{t(`academicGrading.method.${config.grading_method}`)}</Table.Cell>
                <Table.Cell>
                  {config.grading_method === "weighted"
                    ? t("academicGrading.subjects.weightTotals", {
                        term: formatNumber(config.weight_summary.termCategoryTotal),
                        annual: formatNumber(config.weight_summary.annualTotal),
                      })
                    : "—"}
                </Table.Cell>
                <Table.Cell>
                  {config.valid ? (
                    <Badge tone="success">{t("academicGrading.subjects.valid")}</Badge>
                  ) : (
                    <Badge tone="danger">
                      {t("academicGrading.subjects.errors", { count: errors })}
                    </Badge>
                  )}{" "}
                  {warnings > 0 ? (
                    <Badge tone="warning">
                      {t("academicGrading.subjects.warnings", { count: warnings })}
                    </Badge>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={t("academicGrading.subjects.editLabel", {
                        subject: config.subject.name,
                      })}
                      onClick={() => onEdit({ kind: "edit", configId: config.id })}
                    >
                      {canEdit
                        ? t("academicGrading.common.edit")
                        : t("academicGrading.common.view")}
                    </Button>
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("academicGrading.subjects.removeLabel", {
                          subject: config.subject.name,
                        })}
                        onClick={() => setPendingRemove(config)}
                      >
                        {t("academicGrading.common.remove")}
                      </Button>
                    ) : null}
                  </div>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
      <ConfirmModal
        open={pendingRemove !== null}
        title={t("academicGrading.subjects.removeTitle", {
          subject: pendingRemove?.subject.name ?? "",
        })}
        description={t("academicGrading.subjects.removeDescription")}
        confirmLabel={t("academicGrading.common.remove")}
        submitting={remove.isPending}
        onCancel={() => setPendingRemove(null)}
        onConfirm={confirmRemove}
      />
    </section>
  );
}
