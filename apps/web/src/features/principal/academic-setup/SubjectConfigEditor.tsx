import { ERROR_CODES } from "@studafy/constants";
import { hasErrors } from "@studafy/grading-engine";
import { Button, Checkbox, Input, Select, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useTerms } from "../school/queries";

import { Badge, QueryState, SeverityBadge, SourceBadge, TextArea } from "./components";
import {
  AGGREGATIONS,
  CATEGORY_KINDS,
  CATEGORY_SCOPES,
  GRADING_METHODS,
  MISSING_POLICIES,
  REQUIREMENTS,
  RETAKE_POLICIES,
  ROUNDING_MODES,
  displayTotal,
  draftFromConfig,
  draftToBody,
  draftToCreateBody,
  emptyDraft,
  hasIncompleteFields,
  newAssessment,
  newCategory,
  validateDraft,
} from "./config-form";
import { isProblem, problemMessage } from "./errors";
import { ImpactModal } from "./ImpactModal";
import { issueText } from "./issues";
import { useCreateSubjectConfig, useUpdateSubjectConfig } from "./mutations";
import { useGradeScales, useSubjectConfig } from "./queries";

import type { AssessmentDraft, CategoryDraft, ConfigDraft } from "./config-form";
import type { SetupContext } from "./context";
import type { GradeScale, SaveSubjectConfigResult, SubjectConfig } from "./queries";
import type { Term } from "../../admin/timetable/queries";

export type EditorTarget =
  | {
      kind: "create";
      gradeLevelId: string;
      /** Null for a grade default; a section id for a subject taught in that section only. */
      sectionId: string | null;
      subjectId: string;
      subjectName: string;
    }
  | { kind: "edit"; configId: string };

/**
 * Create or edit one subject's grading rules: the rules, the term weights, the categories and the
 * assessments, with the weight totals and the grading engine's validation updating as you type.
 * Saving a change that would recalculate recorded marks first shows its impact and asks to confirm.
 */
export function SubjectConfigEditor({
  ctx,
  target,
  onClose,
}: {
  ctx: SetupContext;
  target: EditorTarget;
  onClose: () => void;
}) {
  const terms = useTerms(ctx.year.id);
  const scales = useGradeScales(ctx.year.id);
  const config = useSubjectConfig(target.kind === "edit" ? target.configId : undefined);
  const loading =
    terms.isPending || scales.isPending || (target.kind === "edit" && config.isPending);
  const error = terms.error ?? scales.error ?? (target.kind === "edit" ? config.error : null);

  if (loading || error) return <QueryState isPending={loading} error={error} />;
  const termList = [...(terms.data ?? [])].sort((a, b) => a.sequence_number - b.sequence_number);

  if (target.kind === "create") {
    return (
      <EditorForm
        ctx={ctx}
        target={target}
        config={null}
        terms={termList}
        scales={scales.data ?? []}
        initial={emptyDraft(termList)}
        onClose={onClose}
      />
    );
  }
  const saved = config.data!;
  return (
    <EditorForm
      key={`${saved.id}-${saved.updated_at}`}
      ctx={ctx}
      target={target}
      config={saved}
      terms={termList}
      scales={scales.data ?? []}
      initial={draftFromConfig(saved)}
      onClose={onClose}
    />
  );
}

function EditorForm({
  ctx,
  target,
  config,
  terms,
  scales,
  initial,
  onClose,
}: {
  ctx: SetupContext;
  target: EditorTarget;
  config: SubjectConfig | null;
  terms: Term[];
  scales: readonly GradeScale[];
  initial: ConfigDraft;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const [draft, setDraft] = useState(initial);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [showIncomplete, setShowIncomplete] = useState(false);
  const [impactOpen, setImpactOpen] = useState(false);
  const create = useCreateSubjectConfig();
  const update = useUpdateSubjectConfig();

  const live = useMemo(() => validateDraft(draft, terms), [draft, terms]);
  const readOnly = !ctx.can.manage || !ctx.configEditable;
  // A published year never runs on a broken configuration: the API refuses such a save.
  const blockedByErrors = ctx.status === "active" && hasErrors(live.issues);
  const weighted = draft.gradingMethod === "weighted";
  const termCategories = draft.categories.filter((category) => category.scope === "term");
  const subjectName = config?.subject.name ?? (target.kind === "create" ? target.subjectName : "");
  const sectionId = config ? config.section_id : target.kind === "create" ? target.sectionId : null;

  const patch = (changes: Partial<ConfigDraft>) => setDraft((prev) => ({ ...prev, ...changes }));
  const patchCategory = (key: string, changes: Partial<CategoryDraft>) =>
    setDraft((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => (c.key === key ? { ...c, ...changes } : c)),
      // An assessment follows its category's scope: annual assessments belong to no term.
      assessments:
        changes.scope === "annual"
          ? prev.assessments.map((a) => (a.categoryKey === key ? { ...a, termId: null } : a))
          : changes.scope === "term"
            ? prev.assessments.map((a) =>
                a.categoryKey === key && a.termId === null
                  ? { ...a, termId: terms[0]?.id ?? null }
                  : a,
              )
            : prev.assessments,
    }));
  const patchAssessment = (key: string, changes: Partial<AssessmentDraft>) =>
    setDraft((prev) => ({
      ...prev,
      assessments: prev.assessments.map((a) => (a.key === key ? { ...a, ...changes } : a)),
    }));

  function finish(result: SaveSubjectConfigResult) {
    show({
      variant: result.config.valid ? "success" : "warning",
      title: t("academicGrading.editor.saved"),
      description: result.config.valid
        ? undefined
        : t("academicGrading.editor.savedWithIssues", {
            count: result.config.issues.filter((issue) => issue.severity === "error").length,
          }),
    });
    onClose();
  }

  function save(confirmImpact: boolean) {
    setSaveError(null);
    if (hasIncompleteFields(draft)) {
      setShowIncomplete(true);
      return;
    }
    setShowIncomplete(false);
    if (target.kind === "create") {
      create.mutate(
        {
          yearId: ctx.year.id,
          gradeLevelId: target.gradeLevelId,
          body: draftToCreateBody(draft, target.subjectId, target.sectionId),
        },
        { onSuccess: finish, onError: setSaveError },
      );
      return;
    }
    update.mutate(
      {
        configId: target.configId,
        body: {
          ...draftToBody(draft),
          confirm_impact: confirmImpact,
          ...(config ? { expected_updated_at: config.updated_at } : {}),
        },
      },
      {
        onSuccess: (result) => {
          setImpactOpen(false);
          finish(result);
        },
        onError: (error) => {
          if (isProblem(error, ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED)) {
            setImpactOpen(true);
          } else {
            setImpactOpen(false);
            setSaveError(error);
          }
        },
      },
    );
  }

  const scaleOptions = [
    { value: "", label: t("academicGrading.editor.gradeDefaultScale") },
    ...scales.map((scale) => ({ value: scale.id, label: scale.name })),
  ];

  return (
    <section className="ag-editor" aria-labelledby="ag-editor-heading">
      <div className="ag-head">
        <h2 id="ag-editor-heading">
          {target.kind === "create"
            ? t("academicGrading.editor.createTitle", { subject: subjectName })
            : t("academicGrading.editor.editTitle", { subject: subjectName })}
        </h2>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
      </div>
      <p className="ag-meta">
        {sectionId === null ? (
          <Badge tone="info">{t("academicGrading.editor.gradeDefault")}</Badge>
        ) : config && config.section_id !== null && config.based_on_revision !== null ? (
          <SourceBadge source="override" />
        ) : (
          <SourceBadge source="section_only" />
        )}{" "}
        <span className="ag-muted">
          {sectionId === null
            ? t("academicGrading.editor.gradeDefaultHelp")
            : t("academicGrading.editor.sectionHelp")}
        </span>
      </p>
      {config && config.mark_count > 0 ? (
        <p className="ag-notice">
          {t("academicGrading.editor.hasMarks", { count: config.mark_count })}
        </p>
      ) : null}
      {readOnly ? (
        <p className="ag-notice">
          {ctx.can.manage
            ? t("academicGrading.editor.locked")
            : t("academicGrading.editor.readOnly")}
        </p>
      ) : null}

      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.editor.rules")}</legend>
        <div className="ag-grid">
          <Select
            label={t("academicGrading.editor.requirement")}
            options={REQUIREMENTS.map((value) => ({
              value,
              label: t(`academicGrading.requirement.${value}`),
            }))}
            value={draft.requirement}
            onChange={(requirement) => patch({ requirement })}
            disabled={readOnly}
          />
          <Select
            label={t("academicGrading.editor.method")}
            options={GRADING_METHODS.map((value) => ({
              value,
              label: t(`academicGrading.method.${value}`),
            }))}
            value={draft.gradingMethod}
            onChange={(gradingMethod) => patch({ gradingMethod })}
            disabled={readOnly}
          />
          <Input
            label={t("academicGrading.editor.maxMarks")}
            type="number"
            min={0}
            value={draft.maxMarks}
            onChange={(event) => patch({ maxMarks: event.target.value })}
          />
          <Input
            label={t("academicGrading.editor.passPercentage")}
            type="number"
            min={0}
            max={100}
            value={draft.passPercentage}
            onChange={(event) => patch({ passPercentage: event.target.value })}
          />
          <Input
            label={t("academicGrading.editor.finalExamPass")}
            helperText={t("academicGrading.editor.finalExamPassHelp")}
            type="number"
            min={0}
            max={100}
            value={draft.finalExamPassPercentage}
            onChange={(event) => patch({ finalExamPassPercentage: event.target.value })}
          />
          <Select
            label={t("academicGrading.editor.scale")}
            options={scaleOptions}
            value={draft.gradeScaleId}
            onChange={(gradeScaleId) => patch({ gradeScaleId })}
            disabled={readOnly}
          />
          <Input
            label={t("academicGrading.editor.averageWeight")}
            helperText={t("academicGrading.editor.averageWeightHelp")}
            type="number"
            min={0}
            value={draft.averageWeight}
            onChange={(event) => patch({ averageWeight: event.target.value })}
          />
          <Input
            label={t("academicGrading.editor.roundingDecimals")}
            type="number"
            min={0}
            max={4}
            value={draft.roundingDecimals}
            onChange={(event) => patch({ roundingDecimals: event.target.value })}
          />
          <Select
            label={t("academicGrading.editor.roundingMode")}
            options={ROUNDING_MODES.map((value) => ({
              value,
              label: t(`academicGrading.rounding.${value}`),
            }))}
            value={draft.roundingMode}
            onChange={(roundingMode) => patch({ roundingMode })}
            disabled={readOnly}
          />
          <Select
            label={t("academicGrading.editor.missingPolicy")}
            options={MISSING_POLICIES.map((value) => ({
              value,
              label: t(`academicGrading.missingPolicy.${value}`),
            }))}
            value={draft.missingPolicy}
            onChange={(missingPolicy) => patch({ missingPolicy })}
            disabled={readOnly}
          />
          <Select
            label={t("academicGrading.editor.absentPolicy")}
            options={MISSING_POLICIES.map((value) => ({
              value,
              label: t(`academicGrading.missingPolicy.${value}`),
            }))}
            value={draft.absentPolicy}
            onChange={(absentPolicy) => patch({ absentPolicy })}
            disabled={readOnly}
          />
          <Select
            label={t("academicGrading.editor.retakePolicy")}
            options={RETAKE_POLICIES.map((value) => ({
              value,
              label: t(`academicGrading.retakePolicy.${value}`),
            }))}
            value={draft.retakePolicy}
            onChange={(retakePolicy) => patch({ retakePolicy })}
            disabled={readOnly}
          />
          {draft.retakePolicy === "capped" ? (
            <Input
              label={t("academicGrading.editor.retakeCap")}
              type="number"
              min={0}
              max={100}
              value={draft.retakeCapPercentage}
              onChange={(event) => patch({ retakeCapPercentage: event.target.value })}
            />
          ) : null}
        </div>
        <div className="ag-checks">
          <Checkbox
            label={t("academicGrading.editor.includeInAverage")}
            checked={draft.includeInAverage}
            onChange={(event) => patch({ includeInAverage: event.target.checked })}
          />
          <Checkbox
            label={t("academicGrading.editor.includeOnCertificate")}
            checked={draft.includeOnCertificate}
            onChange={(event) => patch({ includeOnCertificate: event.target.checked })}
          />
          <Checkbox
            label={t("academicGrading.editor.teachersCanAdd")}
            checked={draft.teachersCanAddAssessments}
            onChange={(event) => patch({ teachersCanAddAssessments: event.target.checked })}
          />
          {draft.teachersCanAddAssessments ? (
            <Checkbox
              label={t("academicGrading.editor.teacherApproval")}
              checked={draft.teacherAssessmentsRequireApproval}
              onChange={(event) =>
                patch({ teacherAssessmentsRequireApproval: event.target.checked })
              }
            />
          ) : null}
        </div>
        <TextArea
          label={t("academicGrading.editor.instructions")}
          value={draft.instructions}
          onChange={(instructions) => patch({ instructions })}
          disabled={readOnly}
        />
      </fieldset>

      {weighted ? (
        <fieldset className="ag-fieldset" disabled={readOnly}>
          <legend>{t("academicGrading.editor.termWeights")}</legend>
          <p className="ag-muted">{t("academicGrading.editor.termWeightsHelp")}</p>
          {terms.length === 0 ? (
            <p className="ag-notice">{t("academicGrading.editor.noTerms")}</p>
          ) : (
            <div className="ag-grid">
              {terms.map((term) => (
                <Input
                  key={term.id}
                  label={t("academicGrading.editor.termWeight", { term: term.name })}
                  type="number"
                  min={0}
                  max={100}
                  suffix="%"
                  value={draft.termWeights[term.id] ?? ""}
                  onChange={(event) =>
                    patch({ termWeights: { ...draft.termWeights, [term.id]: event.target.value } })
                  }
                />
              ))}
            </div>
          )}
        </fieldset>
      ) : null}

      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.editor.categories")}</legend>
        <p className="ag-muted">
          {weighted
            ? t("academicGrading.editor.categoriesHelpWeighted")
            : t("academicGrading.editor.categoriesHelpTotal")}
        </p>
        {draft.categories.length === 0 ? (
          <p className="ag-muted">{t("academicGrading.editor.noCategories")}</p>
        ) : null}
        {draft.categories.map((category, index) => {
          const label =
            category.name.trim() || t("academicGrading.editor.categoryN", { n: index + 1 });
          const used = draft.assessments.some(
            (assessment) => assessment.categoryKey === category.key && assessment.markCount > 0,
          );
          return (
            <div
              key={category.key}
              className="ag-row"
              role="group"
              aria-label={t("academicGrading.editor.categoryGroup", { name: label })}
            >
              <div className="ag-grid">
                <Input
                  label={t("academicGrading.editor.categoryName")}
                  value={category.name}
                  required
                  onChange={(event) => patchCategory(category.key, { name: event.target.value })}
                />
                <Select
                  label={t("academicGrading.editor.categoryKind")}
                  options={CATEGORY_KINDS.map((value) => ({
                    value,
                    label: t(`academicGrading.kind.${value}`),
                  }))}
                  value={category.kind}
                  onChange={(kind) => patchCategory(category.key, { kind })}
                  disabled={readOnly}
                />
                <Select
                  label={t("academicGrading.editor.categoryScope")}
                  options={CATEGORY_SCOPES.map((value) => ({
                    value,
                    label: t(`academicGrading.scope.${value}`),
                  }))}
                  value={category.scope}
                  onChange={(scope) => patchCategory(category.key, { scope })}
                  disabled={readOnly}
                />
                {weighted ? (
                  <Input
                    label={t("academicGrading.editor.categoryWeight")}
                    type="number"
                    min={0}
                    max={100}
                    suffix="%"
                    value={category.weight}
                    onChange={(event) =>
                      patchCategory(category.key, { weight: event.target.value })
                    }
                  />
                ) : null}
                <Select
                  label={t("academicGrading.editor.aggregation")}
                  options={AGGREGATIONS.map((value) => ({
                    value,
                    label: t(`academicGrading.aggregation.${value}`),
                  }))}
                  value={category.aggregation}
                  onChange={(aggregation) => patchCategory(category.key, { aggregation })}
                  disabled={readOnly}
                />
                <Input
                  label={t("academicGrading.editor.dropLowest")}
                  type="number"
                  min={0}
                  max={20}
                  value={category.dropLowest}
                  onChange={(event) =>
                    patchCategory(category.key, { dropLowest: event.target.value })
                  }
                />
              </div>
              <div className="ag-row__actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      assessments: [
                        ...prev.assessments,
                        newAssessment(
                          category,
                          terms.find((term) => (Number(prev.termWeights[term.id]) || 0) > 0)?.id ??
                            terms[0]?.id ??
                            null,
                        ),
                      ],
                    }))
                  }
                >
                  {t("academicGrading.editor.addAssessment")}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={used}
                  aria-label={t("academicGrading.editor.removeCategoryLabel", { name: label })}
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      categories: prev.categories.filter((c) => c.key !== category.key),
                      assessments: prev.assessments.filter((a) => a.categoryKey !== category.key),
                    }))
                  }
                >
                  {t("academicGrading.editor.remove")}
                </Button>
              </div>
              <AssessmentRows
                category={category}
                assessments={draft.assessments.filter((a) => a.categoryKey === category.key)}
                terms={terms}
                readOnly={readOnly}
                onChange={patchAssessment}
                onRemove={(key) =>
                  setDraft((prev) => ({
                    ...prev,
                    assessments: prev.assessments.filter((a) => a.key !== key),
                  }))
                }
              />
            </div>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          onClick={() => patch({ categories: [...draft.categories, newCategory()] })}
        >
          {t("academicGrading.editor.addCategory")}
        </Button>
      </fieldset>

      <section className="ag-card ag-check" aria-labelledby="ag-check-heading">
        <h3 id="ag-check-heading" className="ag-subheading">
          {t("academicGrading.editor.check")}
        </h3>
        {weighted ? (
          <ul className="ag-totals" aria-live="polite">
            {termCategories.length > 0 ? (
              <li>
                {t("academicGrading.editor.termCategoryTotal", {
                  total: formatNumber(displayTotal(live.summary.termCategoryTotal)),
                })}{" "}
                <WeightBadge ok={Math.abs(live.summary.termCategoryTotal - 100) <= 0.001} />
              </li>
            ) : null}
            <li>
              {t("academicGrading.editor.annualTotal", {
                total: formatNumber(displayTotal(live.summary.annualTotal)),
              })}{" "}
              <WeightBadge ok={Math.abs(live.summary.annualTotal - 100) <= 0.001} />
            </li>
            <li>
              <strong>
                {live.summary.valid
                  ? t("academicGrading.editor.weightsValid")
                  : t("academicGrading.editor.weightsInvalid")}
              </strong>
            </li>
          </ul>
        ) : (
          <p className="ag-muted">{t("academicGrading.editor.totalPointsNoWeights")}</p>
        )}
        {live.issues.length === 0 ? (
          <p>{t("academicGrading.editor.noIssues")}</p>
        ) : (
          <ul className="ag-issues">
            {live.issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.ref ?? ""}-${index}`} className="ag-issues__item">
                <SeverityBadge severity={issue.severity} />{" "}
                <span>{issueText(issue, t, live.summary)}</span>
              </li>
            ))}
          </ul>
        )}
        {ctx.status === "draft" && hasErrors(live.issues) ? (
          <p className="ag-muted">{t("academicGrading.editor.draftSaveAllowed")}</p>
        ) : null}
        {blockedByErrors ? (
          <p className="ag-error">{t("academicGrading.editor.activeSaveBlocked")}</p>
        ) : null}
      </section>

      {showIncomplete ? (
        <p className="ag-error" role="alert">
          {t("academicGrading.editor.incompleteFields")}
        </p>
      ) : null}
      {saveError ? (
        <p className="ag-error" role="alert">
          {problemMessage(saveError, t)}
        </p>
      ) : null}
      <div className="ag-actions">
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.cancel")}
        </Button>
        {readOnly ? null : (
          <Button
            type="button"
            loading={(create.isPending || update.isPending) && !impactOpen}
            disabled={blockedByErrors}
            onClick={() => save(false)}
          >
            {t("academicGrading.editor.save")}
          </Button>
        )}
      </div>

      {impactOpen && target.kind === "edit" ? (
        <ImpactModal
          configId={target.configId}
          terms={terms}
          submitting={update.isPending}
          onCancel={() => setImpactOpen(false)}
          onConfirm={() => save(true)}
        />
      ) : null}
    </section>
  );
}

function WeightBadge({ ok }: { ok: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge tone={ok ? "success" : "danger"}>
      {ok ? t("academicGrading.editor.totalOk") : t("academicGrading.editor.totalOff")}
    </Badge>
  );
}

function AssessmentRows({
  category,
  assessments,
  terms,
  readOnly,
  onChange,
  onRemove,
}: {
  category: CategoryDraft;
  assessments: AssessmentDraft[];
  terms: Term[];
  readOnly: boolean;
  onChange: (key: string, changes: Partial<AssessmentDraft>) => void;
  onRemove: (key: string) => void;
}) {
  const { t } = useTranslation();
  if (assessments.length === 0) {
    return <p className="ag-muted">{t("academicGrading.editor.noAssessments")}</p>;
  }
  return (
    <ul className="ag-assessments">
      {assessments.map((assessment, index) => {
        const label =
          assessment.name.trim() || t("academicGrading.editor.assessmentN", { n: index + 1 });
        return (
          <li
            key={assessment.key}
            className="ag-assessment"
            role="group"
            aria-label={t("academicGrading.editor.assessmentGroup", { name: label })}
          >
            <div className="ag-grid ag-grid--dense">
              <Input
                label={t("academicGrading.editor.assessmentName")}
                value={assessment.name}
                required
                onChange={(event) => onChange(assessment.key, { name: event.target.value })}
              />
              {category.scope === "term" ? (
                <Select
                  label={t("academicGrading.editor.term")}
                  options={terms.map((term) => ({ value: term.id, label: term.name }))}
                  value={assessment.termId ?? undefined}
                  onChange={(termId) => onChange(assessment.key, { termId })}
                  disabled={readOnly}
                />
              ) : null}
              <Input
                label={t("academicGrading.editor.assessmentMax")}
                type="number"
                min={0}
                value={assessment.maxMarks}
                onChange={(event) => onChange(assessment.key, { maxMarks: event.target.value })}
              />
              <Input
                label={t("academicGrading.editor.assessmentWeight")}
                type="number"
                min={0}
                value={assessment.weight}
                onChange={(event) => onChange(assessment.key, { weight: event.target.value })}
              />
              <Input
                label={t("academicGrading.editor.assessmentDate")}
                type="date"
                value={assessment.assessmentDate}
                onChange={(event) =>
                  onChange(assessment.key, { assessmentDate: event.target.value })
                }
              />
              <Input
                label={t("academicGrading.editor.dueDate")}
                type="date"
                value={assessment.dueDate}
                onChange={(event) => onChange(assessment.key, { dueDate: event.target.value })}
              />
            </div>
            <div className="ag-row__actions">
              <Checkbox
                label={t("academicGrading.editor.mandatory")}
                checked={assessment.mandatory}
                onChange={(event) => onChange(assessment.key, { mandatory: event.target.checked })}
              />
              {assessment.status !== "active" ? (
                <Badge tone="warning">
                  {t(`academicGrading.assessmentStatus.${assessment.status}`)}
                </Badge>
              ) : null}
              {assessment.markCount > 0 ? (
                <span className="ag-muted">
                  {t("academicGrading.editor.assessmentHasMarks", { count: assessment.markCount })}
                </span>
              ) : null}
              <Button
                type="button"
                variant="tertiary"
                disabled={assessment.markCount > 0}
                aria-label={t("academicGrading.editor.removeAssessmentLabel", { name: label })}
                onClick={() => onRemove(assessment.key)}
              >
                {t("academicGrading.editor.remove")}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
