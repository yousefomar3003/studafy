import { Button, Checkbox, Modal, Select } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useGradeLevels } from "../sections/queries";

import { Badge, QueryState, SeverityBadge } from "./components";
import { problemMessage } from "./errors";
import { useApplyCurriculumTemplate, usePreviewCurriculumTemplate } from "./mutations";
import { useCurriculumTemplates } from "./queries";

import type { SetupContext } from "./context";
import type { CurriculumTemplate, CurriculumTemplatePlan } from "./queries";

/**
 * Set up grades from a built-in curriculum template (IGCSE, IB, American...): choose a template,
 * choose grades, preview what would be created or changed, then apply. Existing configuration is
 * only changed after the preview has shown it and the admin applies again knowingly (the API
 * refuses otherwise). Opened from the overview and the scales tab.
 */
export function CurriculumTemplateDialog({
  ctx,
  onClose,
}: {
  ctx: SetupContext;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith("ar") ? "ar" : "en";
  const templates = useCurriculumTemplates(locale);
  const grades = useGradeLevels();
  const preview = usePreviewCurriculumTemplate();
  const apply = useApplyCurriculumTemplate();
  const [templateId, setTemplateId] = useState<string>();
  const [gradeIds, setGradeIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<CurriculumTemplatePlan | null>(null);

  const template = templates.data?.find((item) => item.id === templateId) ?? templates.data?.[0];
  const gradeList = grades.data ?? [];
  const input = template
    ? { yearId: ctx.year.id, templateId: template.id, gradeLevelIds: gradeIds }
    : null;
  const error = plan ? apply.error : preview.error;

  function toggleGrade(id: string, checked: boolean) {
    setGradeIds((prev) => (checked ? [...prev, id] : prev.filter((gradeId) => gradeId !== id)));
  }

  return (
    <Modal
      open
      size="wide"
      onClose={onClose}
      title={t("academicGrading.templates.title", { year: ctx.year.name })}
      description={t("academicGrading.templates.description")}
    >
      <Modal.Body>
        {plan ? (
          <PlanView plan={plan} />
        ) : (
          <QueryState
            isPending={templates.isPending || grades.isPending}
            error={templates.error ?? grades.error}
          >
            <div className="ag-form">
              <Select
                label={t("academicGrading.templates.template")}
                options={(templates.data ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
                value={template?.id}
                onChange={setTemplateId}
                required
              />
              {template ? <TemplateSummary template={template} /> : null}
              <p className="ag-muted">{t("academicGrading.templates.editableDefaults")}</p>
              <fieldset className="ag-fieldset">
                <legend>{t("academicGrading.templates.grades")}</legend>
                {gradeList.length === 0 ? (
                  <p className="ag-muted">{t("academicGrading.templates.noGrades")}</p>
                ) : (
                  gradeList.map((grade) => (
                    <Checkbox
                      key={grade.id}
                      label={grade.name}
                      checked={gradeIds.includes(grade.id)}
                      onChange={(event) => toggleGrade(grade.id, event.target.checked)}
                    />
                  ))
                )}
              </fieldset>
            </div>
          </QueryState>
        )}
        {error ? (
          <p className="ag-error" role="alert">
            {problemMessage(error, t)}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        {plan?.applied ? (
          <Button type="button" onClick={onClose}>
            {t("academicGrading.common.done")}
          </Button>
        ) : plan ? (
          <>
            <Button type="button" variant="tertiary" onClick={() => setPlan(null)}>
              {t("academicGrading.templates.back")}
            </Button>
            <Button
              type="button"
              loading={apply.isPending}
              onClick={() =>
                input &&
                apply.mutate(
                  { ...input, confirm: plan.requires_confirmation },
                  { onSuccess: setPlan },
                )
              }
            >
              {plan.requires_confirmation
                ? t("academicGrading.templates.applyConfirm")
                : t("academicGrading.templates.apply")}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="tertiary" onClick={onClose}>
              {t("academicGrading.common.cancel")}
            </Button>
            <Button
              type="button"
              loading={preview.isPending}
              disabled={!input || gradeIds.length === 0}
              onClick={() => input && preview.mutate(input, { onSuccess: setPlan })}
            >
              {t("academicGrading.templates.preview")}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}

/** What a template sets: result, pass mark, scale or descriptors, categories, credits. */
function TemplateSummary({ template }: { template: CurriculumTemplate }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const result =
    template.result_format === "percentage"
      ? t("academicGrading.templates.result.percentage")
      : t(`academicGrading.templates.result.${template.result_format}`, {
          max: formatNumber(template.result_scale_max ?? 0),
        });
  return (
    <div className="ag-card">
      <p>{template.description}</p>
      <dl className="ag-dl">
        <div>
          <dt>{t("academicGrading.templates.summary.result")}</dt>
          <dd>{result}</dd>
        </div>
        <div>
          <dt>{t("academicGrading.templates.summary.method")}</dt>
          <dd>{t(`academicGrading.method.${template.grading_method}`)}</dd>
        </div>
        {template.grading_method === "descriptive" ? null : (
          <div>
            <dt>{t("academicGrading.templates.summary.pass")}</dt>
            <dd>{formatNumber(template.pass_percentage, { maximumFractionDigits: 3 })}%</dd>
          </div>
        )}
        {template.subject_credits ? (
          <div>
            <dt>{t("academicGrading.templates.summary.credits")}</dt>
            <dd>{formatNumber(template.subject_credits.credits)}</dd>
          </div>
        ) : null}
      </dl>
      {template.scale ? (
        <p>
          <strong>
            {t("academicGrading.templates.summary.scale", { name: template.scale.name })}
          </strong>{" "}
          {template.scale.bands
            .map((band) =>
              band.gpa_points === null
                ? t("academicGrading.templates.band", {
                    label: band.label,
                    min: formatNumber(band.min_percentage, { maximumFractionDigits: 3 }),
                  })
                : t("academicGrading.templates.bandGpa", {
                    label: band.label,
                    min: formatNumber(band.min_percentage, { maximumFractionDigits: 3 }),
                    gpa: formatNumber(band.gpa_points),
                  }),
            )
            .join(" · ")}
        </p>
      ) : null}
      {template.descriptors ? (
        <p>
          <strong>{t("academicGrading.templates.summary.descriptors")}</strong>{" "}
          {template.descriptors.map((descriptor) => descriptor.label).join(" · ")}
        </p>
      ) : null}
      <p>
        <strong>{t("academicGrading.templates.summary.categories")}</strong>{" "}
        {template.categories_source === "exam_structure"
          ? t("academicGrading.templates.summary.examStructure")
          : template.categories
              .map((category) =>
                category.weight === null
                  ? t("academicGrading.templates.categoryOutOf", {
                      name: category.name,
                      max: formatNumber(category.max_marks),
                    })
                  : t("academicGrading.templates.category", {
                      name: category.name,
                      weight: formatNumber(category.weight),
                    }),
              )
              .join(" · ")}
      </p>
      {template.course_levels.length > 0 ? (
        <p>
          <strong>{t("academicGrading.templates.summary.courseLevels")}</strong>{" "}
          {template.course_levels
            .map((level) =>
              level.gpa_boost > 0
                ? t("academicGrading.templates.courseLevelBoost", {
                    label: level.label,
                    boost: formatNumber(level.gpa_boost),
                  })
                : level.label,
            )
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

/** The preview (or, once applied, the outcome): per grade, what changes. */
function PlanView({ plan }: { plan: CurriculumTemplatePlan }) {
  const { t } = useTranslation();
  const changesExisting = plan.requires_confirmation && !plan.applied;
  return (
    <div className="ag-form">
      {plan.applied ? (
        <p role="status">{t("academicGrading.templates.applied", { name: plan.template_name })}</p>
      ) : changesExisting ? (
        <p className="ag-issues__item" role="alert">
          <SeverityBadge severity="warning" />{" "}
          <span>{t("academicGrading.templates.confirmWarning")}</span>
        </p>
      ) : null}
      {plan.scale ? (
        <p>
          {t(`academicGrading.templates.plan.scale.${plan.scale.action}`, {
            name: plan.scale.name,
          })}
        </p>
      ) : null}
      {plan.grades.map((grade) => (
        <section key={grade.grade_level_id} className="ag-card">
          <h3 className="ag-subheading">{grade.grade_level_name}</h3>
          {grade.error ? (
            <p className="ag-error">
              {t("academicGrading.templates.plan.gradeError", { error: grade.error })}
            </p>
          ) : null}
          <ul className="ag-list">
            <li>
              {grade.program.action === "update"
                ? t("academicGrading.templates.plan.program.update", {
                    changes: grade.program.changes
                      .map((change) => t(`academicGrading.templates.plan.changes.${change}`))
                      .join(", "),
                  })
                : t(`academicGrading.templates.plan.program.${grade.program.action}`)}
            </li>
            {grade.descriptors ? (
              <li>{t(`academicGrading.templates.plan.descriptors.${grade.descriptors}`)}</li>
            ) : null}
            {grade.subjects.length === 0 ? (
              <li className="ag-muted">{t("academicGrading.templates.plan.noSubjects")}</li>
            ) : (
              grade.subjects.map((subject) => (
                <li key={subject.config_id}>
                  {subject.subject_name}{" "}
                  <Badge
                    tone={
                      subject.action === "update"
                        ? "info"
                        : subject.action === "skip"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {t(`academicGrading.templates.plan.subject.${subject.action}`)}
                  </Badge>
                  {subject.reason ? (
                    <span className="ag-muted">
                      {" "}
                      {t(`academicGrading.templates.plan.reason.${subject.reason}`)}
                      {subject.detail ? ` — ${subject.detail}` : ""}
                    </span>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </section>
      ))}
      {!plan.requires_confirmation && !plan.applied && nothingToDo(plan) ? (
        <p className="ag-muted">{t("academicGrading.templates.nothingToChange")}</p>
      ) : null}
    </div>
  );
}

function nothingToDo(plan: CurriculumTemplatePlan): boolean {
  return (
    plan.scale?.action !== "create" &&
    plan.grades.every(
      (grade) =>
        grade.program.action === "unchanged" &&
        (grade.descriptors === null || grade.descriptors === "unchanged") &&
        grade.subjects.every((subject) => subject.action !== "update"),
    )
  );
}
