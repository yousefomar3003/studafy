import { GRADUATION_RULE_TYPES, validateGraduationRule } from "@studafy/grading-engine";
import { Button, Checkbox, Input, Select, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSubjects } from "../school/queries";
import {
  sectionDisplayName,
  useGradeLevels,
  useSections,
  useSectionStudents,
} from "../sections/queries";

import { Badge, ConfirmModal, QueryState, SeverityBadge } from "./components";
import { newKey } from "./config-form";
import { problemMessage } from "./errors";
import { useExternalExams } from "./external-exams";
import {
  useDeleteGraduationSet,
  useGraduationPreview,
  useGraduationReport,
  useGraduationSets,
  useSaveGraduationSet,
} from "./graduation-requirements";
import {
  GraduationSetChecklist,
  GraduationStatusBadge,
  graduationRuleLabel,
} from "./GraduationChecklist";

import type { SetupContext } from "./context";
import type {
  GraduationRuleType,
  GraduationSet,
  GraduationSetBody,
} from "./graduation-requirements";
import type { GraduationRuleDefinition, ValidationIssue } from "@studafy/grading-engine";

interface RuleDraft {
  key: string;
  type: GraduationRuleType;
  minValue: string;
  groupName: string;
  subjectIds: string[];
  examId: string | undefined;
}

interface SetDraft {
  name: string;
  gradeLevelIds: string[];
  fromYearId: string | undefined;
  isActive: boolean;
  visible: boolean;
  rules: RuleDraft[];
}

const usesGroup = (type: GraduationRuleType) =>
  type === "group_credits" || type === "subjects_passed";
const usesMinimum = (type: GraduationRuleType) => type !== "subjects_passed";

function blankRule(type: GraduationRuleType = "total_credits"): RuleDraft {
  return {
    key: newKey("rule"),
    type,
    minValue: "",
    groupName: "",
    subjectIds: [],
    examId: undefined,
  };
}

function draftFrom(set: GraduationSet | null): SetDraft {
  if (!set) {
    return {
      name: "",
      gradeLevelIds: [],
      fromYearId: undefined,
      isActive: true,
      visible: false,
      rules: [blankRule()],
    };
  }
  return {
    name: set.name,
    gradeLevelIds: set.grade_levels.map((grade) => grade.id),
    fromYearId: set.applies_from_academic_year?.id,
    isActive: set.is_active,
    visible: set.visible_to_students_and_parents,
    rules: set.rules.map((rule) => ({
      key: newKey("rule"),
      type: rule.type,
      minValue: rule.min_value === null ? "" : String(rule.min_value),
      groupName: rule.group_name ?? "",
      subjectIds: rule.subjects.map((subject) => subject.id),
      examId: rule.external_exam?.id,
    })),
  };
}

/** The rule as the grading engine sees it, so the form checks exactly what the API will. */
function definitionOf(rule: RuleDraft): Omit<GraduationRuleDefinition, "id"> {
  const group = usesGroup(rule.type);
  const min = rule.minValue.trim();
  return {
    type: rule.type,
    minValue: usesMinimum(rule.type) && min !== "" ? Number(min) : null,
    groupName: group ? rule.groupName.trim() : null,
    subjectIds: group ? rule.subjectIds : [],
    externalExamId: rule.type === "external_exam" ? (rule.examId ?? null) : null,
  };
}

function bodyOf(draft: SetDraft): GraduationSetBody {
  return {
    name: draft.name.trim(),
    grade_level_ids: draft.gradeLevelIds,
    applies_from_academic_year_id: draft.fromYearId ?? null,
    is_active: draft.isActive,
    visible_to_students_and_parents: draft.visible,
    rules: draft.rules.map((rule) => {
      const definition = definitionOf(rule);
      return {
        type: definition.type,
        min_value: definition.minValue,
        group_name: definition.groupName,
        subject_ids: [...definition.subjectIds],
        external_exam_id: definition.externalExamId,
      };
    }),
  };
}

/**
 * The school's graduation requirements: sets of rules (credits, credits in a group of subjects,
 * subjects passed, a cumulative GPA or average, an external exam) for the grade levels they apply
 * to. Not tied to the selected academic year. Leadership adds and edits sets, checks one against a
 * student, and sees the students of a grade who are not on track.
 */
export function GraduationRequirementsTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const canEdit = ctx.can.manage;
  const sets = useGraduationSets();
  const remove = useDeleteGraduationSet();
  const [editing, setEditing] = useState<{ set: GraduationSet | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GraduationSet | null>(null);

  if (editing) {
    return (
      <GraduationSetEditor
        ctx={ctx}
        set={editing.set}
        readOnly={!canEdit}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <>
      <section className="ag-block" aria-labelledby="ag-graduation-heading">
        <div className="ag-head">
          <h2 id="ag-graduation-heading">{t("academicGrading.graduation.heading")}</h2>
          {canEdit ? (
            <Button type="button" variant="secondary" onClick={() => setEditing({ set: null })}>
              {t("academicGrading.graduation.add")}
            </Button>
          ) : null}
        </div>
        <p className="ag-muted">{t("academicGrading.graduation.help")}</p>
        <Table caption={t("academicGrading.graduation.caption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("academicGrading.graduation.columns.name")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.graduation.columns.grades")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.graduation.columns.rules")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.graduation.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={4}
            loading={sets.isPending}
            empty={
              sets.isError ? problemMessage(sets.error, t) : t("academicGrading.graduation.empty")
            }
          >
            {(sets.data ?? []).map((set) => (
              <Table.Row key={set.id}>
                <Table.Cell>
                  <strong>{set.name}</strong>
                  <div>
                    {set.is_active ? null : (
                      <Badge tone="neutral">{t("academicGrading.graduation.inactive")}</Badge>
                    )}{" "}
                    {set.visible_to_students_and_parents ? (
                      <Badge tone="info">{t("academicGrading.graduation.visible")}</Badge>
                    ) : null}{" "}
                    {set.applies_from_academic_year ? (
                      <span className="ag-muted">
                        {t("academicGrading.graduation.fromYear", {
                          year: set.applies_from_academic_year.name,
                        })}
                      </span>
                    ) : null}
                  </div>
                </Table.Cell>
                <Table.Cell>{set.grade_levels.map((grade) => grade.name).join(", ")}</Table.Cell>
                <Table.Cell>
                  {set.rules.map((rule) => graduationRuleLabel(rule, t)).join(" · ") || "—"}
                </Table.Cell>
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={t("academicGrading.graduation.editLabel", { name: set.name })}
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
                        aria-label={t("academicGrading.graduation.deleteLabel", { name: set.name })}
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
          title={t("academicGrading.graduation.deleteTitle", { name: pendingDelete?.name ?? "" })}
          description={t("academicGrading.graduation.deleteDescription")}
          confirmLabel={t("academicGrading.common.remove")}
          submitting={remove.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() =>
            pendingDelete &&
            remove.mutate(pendingDelete.id, {
              onSuccess: () => {
                show({ variant: "success", title: t("academicGrading.graduation.deleted") });
                setPendingDelete(null);
              },
              onError: (error) => {
                show({
                  variant: "error",
                  title: t("academicGrading.graduation.deleteFailed"),
                  description: problemMessage(error, t),
                });
                setPendingDelete(null);
              },
            })
          }
        />
      </section>
      {canEdit && (sets.data ?? []).length > 0 ? (
        <>
          <GraduationPreview ctx={ctx} sets={sets.data ?? []} />
          <NotOnTrackReport ctx={ctx} />
        </>
      ) : null}
    </>
  );
}

/** Check a saved set against one student of the selected year, whether or not it applies. */
function GraduationPreview({ ctx, sets }: { ctx: SetupContext; sets: readonly GraduationSet[] }) {
  const { t } = useTranslation();
  const [setId, setSetId] = useState<string | undefined>(sets[0]?.id);
  const [sectionId, setSectionId] = useState<string | undefined>(undefined);
  const [studentId, setStudentId] = useState<string | undefined>(undefined);
  const sections = useSections(ctx.year.id);
  const students = useSectionStudents(sectionId);
  const preview = useGraduationPreview(setId, studentId);

  return (
    <section className="ag-block" aria-labelledby="ag-graduation-preview-heading">
      <h2 id="ag-graduation-preview-heading">{t("academicGrading.graduation.preview.heading")}</h2>
      <p className="ag-muted">{t("academicGrading.graduation.preview.help")}</p>
      <div className="ag-row ag-grid ag-grid--dense">
        <Select
          label={t("academicGrading.graduation.preview.set")}
          options={sets.map((set) => ({ value: set.id, label: set.name }))}
          value={setId}
          onChange={setSetId}
        />
        <Select
          label={t("academicGrading.graduation.preview.section")}
          placeholder={t("academicGrading.graduation.preview.sectionPlaceholder")}
          options={(sections.data ?? []).map((section) => ({
            value: section.id,
            label: sectionDisplayName(section, t),
          }))}
          value={sectionId}
          disabled={sections.isPending}
          onChange={(id) => {
            setSectionId(id);
            setStudentId(undefined);
          }}
        />
        <Select
          label={t("academicGrading.graduation.preview.student")}
          placeholder={t("academicGrading.graduation.preview.studentPlaceholder")}
          options={(students.data ?? []).map((student) => ({
            value: student.student_id,
            label: `${student.first_name} ${student.last_name}`,
          }))}
          value={studentId}
          disabled={sectionId === undefined || students.isPending}
          onChange={setStudentId}
        />
      </div>
      {setId && studentId ? (
        <QueryState isPending={preview.isPending} error={preview.error}>
          {preview.data ? (
            <>
              <p className={preview.data.applies ? "ag-muted" : "ag-notice"} role="note">
                {preview.data.applies
                  ? t("academicGrading.graduation.preview.applies")
                  : t("academicGrading.graduation.preview.doesNotApply")}
                {preview.data.current_year_pending
                  ? ` ${t("academicGrading.graduation.currentYearPending")}`
                  : ""}
              </p>
              <GraduationSetChecklist evaluation={preview.data} />
            </>
          ) : null}
        </QueryState>
      ) : null}
    </section>
  );
}

/** Students of a grade in the selected year with a set not met, or not met yet. */
function NotOnTrackReport({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const grades = useGradeLevels();
  const [gradeLevelId, setGradeLevelId] = useState<string | undefined>(undefined);
  const [includePending, setIncludePending] = useState(false);
  const report = useGraduationReport(gradeLevelId ? ctx.year.id : undefined, gradeLevelId);
  const students = (report.data?.students ?? []).filter(
    (student) => includePending || student.status === "not_met",
  );

  return (
    <section className="ag-block" aria-labelledby="ag-graduation-report-heading">
      <h2 id="ag-graduation-report-heading">{t("academicGrading.graduation.report.heading")}</h2>
      <p className="ag-muted">
        {t("academicGrading.graduation.report.help", { year: ctx.year.name })}
      </p>
      <div className="ag-row ag-grid ag-grid--dense">
        <Select
          label={t("academicGrading.graduation.report.grade")}
          placeholder={t("academicGrading.graduation.report.gradePlaceholder")}
          options={(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name }))}
          value={gradeLevelId}
          disabled={grades.isPending}
          onChange={setGradeLevelId}
        />
      </div>
      <Checkbox
        label={t("academicGrading.graduation.report.includePending")}
        checked={includePending}
        onChange={(event) => setIncludePending(event.target.checked)}
      />
      {gradeLevelId ? (
        <QueryState isPending={report.isPending} error={report.error}>
          <p className="ag-muted">
            {t("academicGrading.graduation.report.summary", {
              shown: formatNumber(students.length),
              checked: formatNumber(report.data?.students_checked ?? 0),
            })}
          </p>
          <Table caption={t("academicGrading.graduation.report.heading")} hideCaption>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>
                  {t("academicGrading.graduation.report.columns.student")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.graduation.report.columns.section")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.graduation.report.columns.status")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.graduation.report.columns.unmet")}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body columnCount={4} empty={t("academicGrading.graduation.report.empty")}>
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
                    <GraduationStatusBadge status={student.status} />
                  </Table.Cell>
                  <Table.Cell>
                    {student.sets
                      .map(
                        (set) =>
                          `${set.set.name}: ${set.rules
                            .filter((rule) => rule.status !== "met")
                            .map((rule) => graduationRuleLabel(rule, t))
                            .join(", ")}`,
                      )
                      .join(" · ")}
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

function GraduationSetEditor({
  ctx,
  set,
  readOnly,
  onClose,
}: {
  ctx: SetupContext;
  set: GraduationSet | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveGraduationSet();
  const grades = useGradeLevels();
  const subjects = useSubjects();
  const exams = useExternalExams(true);
  const [draft, setDraft] = useState<SetDraft>(() => draftFrom(set));

  const issues = useMemo(() => {
    const found: (ValidationIssue & { key: string })[] = [];
    if (draft.name.trim() === "") {
      found.push({
        key: "name",
        code: "NAME",
        severity: "error",
        message: t("academicGrading.graduation.nameRequired"),
      });
    }
    if (draft.gradeLevelIds.length === 0) {
      found.push({
        key: "grades",
        code: "GRADES",
        severity: "error",
        message: t("academicGrading.graduation.gradesRequired"),
      });
    }
    draft.rules.forEach((rule, index) => {
      for (const issue of validateGraduationRule(definitionOf(rule))) {
        found.push({
          ...issue,
          key: `${rule.key}-${issue.code}`,
          message: t("academicGrading.graduation.ruleIssue", {
            n: index + 1,
            message: issue.message,
          }),
        });
      }
    });
    return found;
  }, [draft, t]);

  const patch = (changes: Partial<SetDraft>) => setDraft((prev) => ({ ...prev, ...changes }));
  const patchRule = (key: string, changes: Partial<RuleDraft>) =>
    setDraft((prev) => ({
      ...prev,
      rules: prev.rules.map((rule) => (rule.key === key ? { ...rule, ...changes } : rule)),
    }));
  const toggle = (list: readonly string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((candidate) => candidate !== id);

  function submit() {
    save.mutate(
      { setId: set?.id ?? null, body: bodyOf(draft) },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.graduation.saved") });
          onClose();
        },
      },
    );
  }

  return (
    <section className="ag-editor" aria-labelledby="ag-graduation-editor-heading">
      <div className="ag-head">
        <h2 id="ag-graduation-editor-heading">
          {set
            ? t("academicGrading.graduation.editTitle", { name: set.name })
            : t("academicGrading.graduation.add")}
        </h2>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.editor.back")}
        </Button>
      </div>
      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.graduation.details")}</legend>
        <div className="ag-grid ag-grid--dense">
          <Input
            label={t("academicGrading.graduation.name")}
            value={draft.name}
            required
            maxLength={120}
            onChange={(event) => patch({ name: event.target.value })}
          />
          <Select
            label={t("academicGrading.graduation.fromYearLabel")}
            placeholder={t("academicGrading.graduation.everyYear")}
            options={[
              { value: "", label: t("academicGrading.graduation.everyYear") },
              ...ctx.years.map((year) => ({ value: year.id, label: year.name })),
            ]}
            value={draft.fromYearId ?? ""}
            onChange={(id) => patch({ fromYearId: id === "" ? undefined : id })}
          />
        </div>
        <Checkbox
          label={t("academicGrading.graduation.activeLabel")}
          checked={draft.isActive}
          onChange={(event) => patch({ isActive: event.target.checked })}
        />
        <Checkbox
          label={t("academicGrading.graduation.visibleLabel")}
          checked={draft.visible}
          onChange={(event) => patch({ visible: event.target.checked })}
        />
      </fieldset>

      <fieldset className="ag-fieldset" disabled={readOnly}>
        <legend>{t("academicGrading.graduation.gradesLegend")}</legend>
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
        <legend>{t("academicGrading.graduation.rulesLegend")}</legend>
        <p className="ag-muted">{t("academicGrading.graduation.rulesHelp")}</p>
        {draft.rules.map((rule, index) => (
          <div
            key={rule.key}
            className="ag-row"
            role="group"
            aria-label={t("academicGrading.graduation.ruleN", { n: index + 1 })}
          >
            <div className="ag-grid ag-grid--dense">
              <Select<GraduationRuleType>
                label={t("academicGrading.graduation.ruleTypeLabel")}
                options={GRADUATION_RULE_TYPES.map((type) => ({
                  value: type,
                  label: t(`academicGrading.graduation.ruleType.${type}`),
                }))}
                value={rule.type}
                onChange={(type) => patchRule(rule.key, { type })}
              />
              {usesMinimum(rule.type) ? (
                <Input
                  label={t(`academicGrading.graduation.minLabel.${rule.type}`)}
                  type="number"
                  min={0}
                  step="any"
                  value={rule.minValue}
                  required={rule.type !== "external_exam"}
                  onChange={(event) => patchRule(rule.key, { minValue: event.target.value })}
                />
              ) : null}
              {usesGroup(rule.type) ? (
                <Input
                  label={t("academicGrading.graduation.groupName")}
                  helperText={t("academicGrading.graduation.groupNameHelp")}
                  value={rule.groupName}
                  required
                  maxLength={120}
                  onChange={(event) => patchRule(rule.key, { groupName: event.target.value })}
                />
              ) : null}
              {rule.type === "external_exam" ? (
                <Select
                  label={t("academicGrading.graduation.exam")}
                  placeholder={t("academicGrading.graduation.examPlaceholder")}
                  options={(exams.data ?? []).map((exam) => ({ value: exam.id, label: exam.name }))}
                  value={rule.examId}
                  disabled={exams.isPending}
                  onChange={(examId) => patchRule(rule.key, { examId })}
                />
              ) : null}
            </div>
            {usesGroup(rule.type) ? (
              <div
                className="ag-checks ag-checks--scroll"
                role="group"
                aria-label={t("academicGrading.graduation.subjectsLabel", { n: index + 1 })}
              >
                {(subjects.data ?? []).map((subject) => (
                  <Checkbox
                    key={subject.id}
                    label={`${subject.name} (${subject.code})`}
                    checked={rule.subjectIds.includes(subject.id)}
                    onChange={(event) =>
                      patchRule(rule.key, {
                        subjectIds: toggle(rule.subjectIds, subject.id, event.target.checked),
                      })
                    }
                  />
                ))}
              </div>
            ) : null}
            <div className="ag-row__actions">
              <Button
                type="button"
                variant="tertiary"
                aria-label={t("academicGrading.graduation.removeRule", { n: index + 1 })}
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    rules: prev.rules.filter((candidate) => candidate.key !== rule.key),
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
          onClick={() => setDraft((prev) => ({ ...prev, rules: [...prev.rules, blankRule()] }))}
        >
          {t("academicGrading.graduation.addRule")}
        </Button>
      </fieldset>

      <section className="ag-card ag-check" aria-label={t("academicGrading.editor.check")}>
        {issues.length === 0 ? (
          <p>{t("academicGrading.graduation.valid")}</p>
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
            {t("academicGrading.graduation.save")}
          </Button>
        )}
      </div>
    </section>
  );
}
