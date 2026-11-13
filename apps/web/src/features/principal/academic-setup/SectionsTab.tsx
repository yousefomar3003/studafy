import { Button, Chip, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { useSubjects, useTeacherContacts } from "../school/queries";
import { sectionDisplayName, useSectionStudents, useSections } from "../sections/queries";

import { Badge, ConfirmModal, QueryState, ReasonModal, SourceBadge } from "./components";
import { problemMessage } from "./errors";
import {
  useAssignTeacher,
  useCreateOverride,
  useDeleteSubjectConfig,
  useKeepOverride,
  useRemoveTeacherAssignment,
  useResetToGradeDefault,
  useSetSubjectEnrollment,
} from "./mutations";
import { useSectionGradingSubjects, useSubjectEnrollments } from "./queries";
import { SubjectConfigEditor } from "./SubjectConfigEditor";

import type { SetupContext } from "./context";
import type { SectionGradingSubject, SectionGradingSubjects } from "./queries";
import type { EditorTarget } from "./SubjectConfigEditor";
import type { Section } from "../sections/queries";

type PendingAction =
  | { kind: "exclude"; subject: SectionGradingSubject }
  | { kind: "reset"; subject: SectionGradingSubject }
  | { kind: "remove"; subject: SectionGradingSubject };

/**
 * Per section: every subject with where it comes from — inherited from the grade default,
 * overridden for this section, taught in this section only, or excluded — plus outdated overrides
 * (the grade default changed after the override was made), teachers, and elective choices and
 * exemptions.
 */
export function SectionsTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const sections = useSections(ctx.year.id);
  const [pickedId, setPickedId] = useState<string>();
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const list = [...(sections.data ?? [])].sort((a, b) =>
    sectionDisplayName(a, t).localeCompare(sectionDisplayName(b, t)),
  );
  const section = list.find((s) => s.id === pickedId) ?? list[0];

  if (editor) {
    return <SubjectConfigEditor ctx={ctx} target={editor} onClose={() => setEditor(null)} />;
  }

  return (
    <QueryState
      isPending={sections.isPending}
      error={sections.error}
      empty={list.length === 0}
      emptyText={t("academicGrading.sections.noSections")}
    >
      <div className="principal-school__filters">
        <Select
          label={t("academicGrading.sections.sectionLabel")}
          options={list.map((s) => ({ value: s.id, label: sectionDisplayName(s, t) }))}
          value={section?.id}
          onChange={setPickedId}
        />
      </div>
      {section ? (
        <SectionDetail key={section.id} ctx={ctx} section={section} onEdit={setEditor} />
      ) : null}
    </QueryState>
  );
}

function SectionDetail({
  ctx,
  section,
  onEdit,
}: {
  ctx: SetupContext;
  section: Section;
  onEdit: (target: EditorTarget) => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const data = useSectionGradingSubjects(section.id);
  const createOverride = useCreateOverride();
  const reset = useResetToGradeDefault();
  const keep = useKeepOverride();
  const removeConfig = useDeleteSubjectConfig();
  const removeTeacher = useRemoveTeacherAssignment();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [assignFor, setAssignFor] = useState<SectionGradingSubject | null>(null);
  const canEdit = ctx.can.manage && ctx.configEditable;
  const label = sectionDisplayName(section, t);

  const fail = (title: string) => (error: unknown) =>
    show({ variant: "error", title, description: problemMessage(error, t) });

  function customize(subject: SectionGradingSubject) {
    createOverride.mutate(
      { sectionId: section.id, subjectId: subject.subject_id, mode: "customize" },
      {
        onSuccess: (result) => onEdit({ kind: "edit", configId: result.config.id }),
        onError: fail(t("academicGrading.sections.actionFailed")),
      },
    );
  }

  function runPending() {
    if (!pending) return;
    const { subject } = pending;
    const done = (title: string) => () => {
      show({ variant: "success", title });
      setPending(null);
    };
    const failed = (error: unknown) => {
      fail(t("academicGrading.sections.actionFailed"))(error);
      setPending(null);
    };
    if (pending.kind === "exclude") {
      createOverride.mutate(
        { sectionId: section.id, subjectId: subject.subject_id, mode: "exclude" },
        { onSuccess: done(t("academicGrading.sections.excluded")), onError: failed },
      );
    } else if (pending.kind === "reset" && subject.override_config_id) {
      reset.mutate(subject.override_config_id, {
        onSuccess: done(t("academicGrading.sections.resetDone")),
        onError: failed,
      });
    } else if (pending.kind === "remove" && subject.config_id) {
      removeConfig.mutate(subject.config_id, {
        onSuccess: done(t("academicGrading.sections.removed")),
        onError: failed,
      });
    }
  }

  function keepOverride(subject: SectionGradingSubject) {
    if (!subject.override_config_id) return;
    keep.mutate(subject.override_config_id, {
      onSuccess: () => show({ variant: "success", title: t("academicGrading.sections.kept") }),
      onError: fail(t("academicGrading.sections.actionFailed")),
    });
  }

  return (
    <>
      <section className="ag-block" aria-labelledby="ag-section-subjects-heading">
        <div className="ag-head">
          <h2 id="ag-section-subjects-heading">
            {t("academicGrading.sections.subjectsHeading", { section: label })}
          </h2>
        </div>
        <ul className="ag-legend" aria-label={t("academicGrading.sections.legendLabel")}>
          {(["inherited", "override", "section_only", "excluded"] as const).map((source) => (
            <li key={source}>
              <SourceBadge source={source} />{" "}
              <span className="ag-muted">{t(`academicGrading.sourceHelp.${source}`)}</span>
            </li>
          ))}
        </ul>
        <Table
          caption={t("academicGrading.sections.subjectsCaption", { section: label })}
          hideCaption
        >
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("academicGrading.sections.columns.subject")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.sections.columns.source")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.sections.columns.teachers")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.sections.columns.actions")}</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={4}
            loading={data.isPending}
            empty={
              data.isError ? problemMessage(data.error, t) : t("academicGrading.sections.empty")
            }
          >
            {(data.data?.subjects ?? []).map((subject) => (
              <Table.Row key={subject.subject_id}>
                <Table.Cell>
                  <span className={subject.source === "excluded" ? "ag-struck" : undefined}>
                    {subject.subject_name}
                  </span>{" "}
                  <span className="ag-muted">({subject.subject_code})</span>
                  {subject.source !== "excluded" ? (
                    <div className="ag-muted">
                      {t(`academicGrading.requirement.${subject.requirement}`)}
                    </div>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  <SourceBadge source={subject.source} />
                  {subject.outdated ? (
                    <div className="ag-outdated" role="note">
                      <Badge tone="warning">{t("academicGrading.sections.outdated")}</Badge>{" "}
                      {t("academicGrading.sections.outdatedHelp", {
                        current: subject.grade_revision ?? "—",
                        based: subject.based_on_revision ?? "—",
                      })}
                    </div>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  {subject.source === "excluded" ? (
                    "—"
                  ) : (
                    <TeacherChips
                      subject={subject}
                      canEdit={canEdit}
                      onRemove={(assignmentId, name) =>
                        removeTeacher.mutate(assignmentId, {
                          onSuccess: () =>
                            show({
                              variant: "success",
                              title: t("academicGrading.sections.teacherRemoved", { name }),
                            }),
                          onError: fail(t("academicGrading.sections.actionFailed")),
                        })
                      }
                    />
                  )}
                </Table.Cell>
                <Table.Cell>
                  <SubjectActions
                    subject={subject}
                    canEdit={canEdit}
                    busy={createOverride.isPending || keep.isPending}
                    onCustomize={() => customize(subject)}
                    onEdit={() =>
                      subject.config_id && onEdit({ kind: "edit", configId: subject.config_id })
                    }
                    onExclude={() => setPending({ kind: "exclude", subject })}
                    onReset={() => setPending({ kind: "reset", subject })}
                    onKeep={() => keepOverride(subject)}
                    onRemove={() => setPending({ kind: "remove", subject })}
                    onAssign={() => setAssignFor(subject)}
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        {canEdit && data.data ? (
          <SectionOnlySubject
            ctx={ctx}
            section={data.data.section}
            existing={data.data.subjects}
            onEdit={onEdit}
          />
        ) : null}
      </section>

      {data.data ? <Enrollments ctx={ctx} section={section} subjects={data.data.subjects} /> : null}

      <ConfirmModal
        open={pending !== null}
        title={
          pending
            ? t(`academicGrading.sections.confirm.${pending.kind}.title`, {
                subject: pending.subject.subject_name,
                section: label,
              })
            : ""
        }
        description={
          pending ? t(`academicGrading.sections.confirm.${pending.kind}.description`) : undefined
        }
        confirmLabel={pending ? t(`academicGrading.sections.confirm.${pending.kind}.action`) : ""}
        submitting={createOverride.isPending || reset.isPending || removeConfig.isPending}
        onCancel={() => setPending(null)}
        onConfirm={runPending}
      />
      {assignFor ? (
        <AssignTeacherModal
          sectionId={section.id}
          subject={assignFor}
          onClose={() => setAssignFor(null)}
        />
      ) : null}
    </>
  );
}

function SubjectActions({
  subject,
  canEdit,
  busy,
  onCustomize,
  onEdit,
  onExclude,
  onReset,
  onKeep,
  onRemove,
  onAssign,
}: {
  subject: SectionGradingSubject;
  canEdit: boolean;
  busy: boolean;
  onCustomize: () => void;
  onEdit: () => void;
  onExclude: () => void;
  onReset: () => void;
  onKeep: () => void;
  onRemove: () => void;
  onAssign: () => void;
}) {
  const { t } = useTranslation();
  const name = subject.subject_name;
  if (!canEdit) {
    return subject.config_id && subject.source !== "excluded" ? (
      <Button type="button" variant="tertiary" onClick={onEdit}>
        {t("academicGrading.common.view")}
      </Button>
    ) : null;
  }
  return (
    <div className="sections-page__row-actions">
      {subject.outdated ? (
        <>
          <Button
            type="button"
            variant="secondary"
            aria-label={t("academicGrading.sections.acceptDefaultLabel", { subject: name })}
            onClick={onReset}
          >
            {t("academicGrading.sections.acceptDefault")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            loading={busy}
            aria-label={t("academicGrading.sections.keepLabel", { subject: name })}
            onClick={onKeep}
          >
            {t("academicGrading.sections.keep")}
          </Button>
        </>
      ) : null}
      {subject.source === "inherited" ? (
        <>
          <Button
            type="button"
            variant="tertiary"
            loading={busy}
            aria-label={t("academicGrading.sections.customizeLabel", { subject: name })}
            onClick={onCustomize}
          >
            {t("academicGrading.sections.customize")}
          </Button>
          <Button
            type="button"
            variant="tertiary"
            aria-label={t("academicGrading.sections.excludeLabel", { subject: name })}
            onClick={onExclude}
          >
            {t("academicGrading.sections.exclude")}
          </Button>
        </>
      ) : null}
      {subject.source === "override" ? (
        <>
          <Button
            type="button"
            variant="tertiary"
            aria-label={t("academicGrading.sections.editOverrideLabel", { subject: name })}
            onClick={onEdit}
          >
            {t("academicGrading.sections.editOverride")}
          </Button>
          {subject.outdated ? null : (
            <Button
              type="button"
              variant="tertiary"
              aria-label={t("academicGrading.sections.useDefaultLabel", { subject: name })}
              onClick={onReset}
            >
              {t("academicGrading.sections.useDefault")}
            </Button>
          )}
        </>
      ) : null}
      {subject.source === "excluded" ? (
        <Button
          type="button"
          variant="tertiary"
          aria-label={t("academicGrading.sections.offerAgainLabel", { subject: name })}
          onClick={onReset}
        >
          {t("academicGrading.sections.offerAgain")}
        </Button>
      ) : null}
      {subject.source === "section_only" ? (
        <>
          <Button type="button" variant="tertiary" onClick={onEdit}>
            {t("academicGrading.common.edit")}
          </Button>
          <Button
            type="button"
            variant="tertiary"
            aria-label={t("academicGrading.sections.removeLabel", { subject: name })}
            onClick={onRemove}
          >
            {t("academicGrading.common.remove")}
          </Button>
        </>
      ) : null}
      {subject.source !== "excluded" ? (
        <Button
          type="button"
          variant="tertiary"
          aria-label={t("academicGrading.sections.assignLabel", { subject: name })}
          onClick={onAssign}
        >
          {t("academicGrading.sections.assign")}
        </Button>
      ) : null}
    </div>
  );
}

function TeacherChips({
  subject,
  canEdit,
  onRemove,
}: {
  subject: SectionGradingSubject;
  canEdit: boolean;
  onRemove: (assignmentId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  if (subject.teachers.length === 0) {
    return <Badge tone="danger">{t("academicGrading.sections.noTeacher")}</Badge>;
  }
  return (
    <div className="ag-chips">
      {subject.teachers.map((teacher) => {
        const assignmentId = teacher.assignment_id;
        return (
          <Chip
            key={`${teacher.teacher_id}-${assignmentId ?? "class"}`}
            variant="outlined"
            onRemove={
              canEdit && assignmentId ? () => onRemove(assignmentId, teacher.name) : undefined
            }
            removeLabel={t("academicGrading.sections.removeTeacherLabel", { name: teacher.name })}
            title={assignmentId ? undefined : t("academicGrading.sections.fromClass")}
          >
            {teacher.name}
            {assignmentId ? null : ` · ${t("academicGrading.sections.fromClassShort")}`}
          </Chip>
        );
      })}
    </div>
  );
}

function AssignTeacherModal({
  sectionId,
  subject,
  onClose,
}: {
  sectionId: string;
  subject: SectionGradingSubject;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const teachers = useTeacherContacts();
  const assign = useAssignTeacher();
  const [teacherId, setTeacherId] = useState<string>();
  const assigned = new Set(subject.teachers.map((teacher) => teacher.teacher_id));
  const options = (teachers.data ?? [])
    .filter((teacher) => !assigned.has(teacher.id))
    .map((teacher) => ({ value: teacher.id, label: teacher.display_name }));

  function submit() {
    if (!teacherId) return;
    assign.mutate(
      { section_id: sectionId, subject_id: subject.subject_id, teacher_id: teacherId },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.sections.assigned") });
          onClose();
        },
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("academicGrading.sections.assignTitle", { subject: subject.subject_name })}
    >
      <Modal.Body>
        <Select
          label={t("academicGrading.sections.teacher")}
          options={options}
          value={teacherId}
          onChange={setTeacherId}
          placeholder={
            teachers.isPending
              ? t("academicGrading.common.loading")
              : t("academicGrading.sections.pickTeacher")
          }
          disabled={options.length === 0}
          required
        />
        {assign.isError ? (
          <p className="ag-error" role="alert">
            {problemMessage(assign.error, t)}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.cancel")}
        </Button>
        <Button type="button" loading={assign.isPending} disabled={!teacherId} onClick={submit}>
          {t("academicGrading.sections.assign")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** A subject the grade does not have, taught (and configured) in this one section. */
function SectionOnlySubject({
  ctx,
  section,
  existing,
  onEdit,
}: {
  ctx: SetupContext;
  section: SectionGradingSubjects["section"];
  existing: readonly SectionGradingSubject[];
  onEdit: (target: EditorTarget) => void;
}) {
  const { t } = useTranslation();
  const subjects = useSubjects(ctx.can.manage);
  const [subjectId, setSubjectId] = useState<string>();
  const taken = new Set(existing.map((subject) => subject.subject_id));
  const available = (subjects.data ?? []).filter((subject) => !taken.has(subject.id));

  return (
    <div className="principal-school__filters">
      <Select
        label={t("academicGrading.sections.addSectionOnly")}
        options={available.map((subject) => ({
          value: subject.id,
          label: `${subject.name} (${subject.code})`,
        }))}
        value={subjectId}
        onChange={setSubjectId}
        placeholder={t("academicGrading.subjects.addPlaceholder")}
        disabled={available.length === 0}
      />
      <div className="principal-school__actions">
        <Button
          type="button"
          variant="secondary"
          disabled={!subjectId}
          onClick={() => {
            const subject = available.find((s) => s.id === subjectId);
            if (!subject) return;
            onEdit({
              kind: "create",
              gradeLevelId: section.grade_level_id,
              sectionId: section.id,
              subjectId: subject.id,
              subjectName: subject.name,
            });
          }}
        >
          {t("academicGrading.subjects.add")}
        </Button>
      </div>
    </div>
  );
}

type EnrollmentChoice = "default" | "enrolled" | "exempt";

/** Who takes an elective, and who is exempt from a subject (with the reason on record). */
function Enrollments({
  ctx,
  section,
  subjects,
}: {
  ctx: SetupContext;
  section: Section;
  subjects: readonly SectionGradingSubject[];
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const students = useSectionStudents(section.id);
  const enrollments = useSubjectEnrollments(section.id);
  const setEnrollment = useSetSubjectEnrollment();
  const offered = subjects.filter(
    (subject) => subject.config_id !== null && subject.source !== "excluded",
  );
  const [subjectId, setSubjectId] = useState<string | undefined>(
    offered.find((subject) => subject.requirement === "elective")?.subject_id ??
      offered[0]?.subject_id,
  );
  const [exempting, setExempting] = useState<{ studentId: string; name: string } | null>(null);
  const subject = offered.find((s) => s.subject_id === subjectId);
  const canEdit = ctx.can.manage && ctx.configEditable;

  function apply(studentId: string, status: "enrolled" | "exempt" | "none", reason?: string) {
    if (!subject) return;
    setEnrollment.mutate(
      {
        sectionId: section.id,
        body: {
          student_id: studentId,
          subject_id: subject.subject_id,
          status,
          reason: reason ?? null,
        },
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.enrollments.saved") });
          setExempting(null);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.enrollments.failed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <section className="ag-block" aria-labelledby="ag-enrollments-heading">
      <h2 id="ag-enrollments-heading">{t("academicGrading.enrollments.heading")}</h2>
      <p className="ag-muted">{t("academicGrading.enrollments.help")}</p>
      {offered.length === 0 ? (
        <p className="ag-muted">{t("academicGrading.enrollments.noSubjects")}</p>
      ) : (
        <>
          <div className="principal-school__filters">
            <Select
              label={t("academicGrading.enrollments.subject")}
              options={offered.map((s) => ({
                value: s.subject_id,
                label: `${s.subject_name} — ${t(`academicGrading.requirement.${s.requirement}`)}`,
              }))}
              value={subject?.subject_id}
              onChange={setSubjectId}
            />
          </div>
          {subject ? (
            <Table
              caption={t("academicGrading.enrollments.caption", { subject: subject.subject_name })}
              hideCaption
            >
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t("academicGrading.enrollments.student")}</Table.HeaderCell>
                  <Table.HeaderCell>{t("academicGrading.enrollments.status")}</Table.HeaderCell>
                  <Table.HeaderCell>{t("academicGrading.enrollments.reason")}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body
                columnCount={3}
                loading={students.isPending || enrollments.isPending}
                empty={
                  students.isError || enrollments.isError
                    ? problemMessage(students.error ?? enrollments.error, t)
                    : t("academicGrading.enrollments.noStudents")
                }
              >
                {(students.data ?? []).map((student) => {
                  const record = enrollments.data?.find(
                    (row) =>
                      row.student_id === student.student_id &&
                      row.subject_id === subject.subject_id,
                  );
                  const choice: EnrollmentChoice = record?.status ?? "default";
                  const name = `${student.first_name} ${student.last_name}`;
                  const defaultLabel =
                    subject.requirement === "elective"
                      ? t("academicGrading.enrollments.defaultElective")
                      : t("academicGrading.enrollments.defaultTakes");
                  return (
                    <Table.Row key={student.student_id}>
                      <Table.Cell>
                        {name} <span className="ag-muted">({student.admission_number})</span>
                      </Table.Cell>
                      <Table.Cell>
                        {canEdit ? (
                          <Select<EnrollmentChoice>
                            label={t("academicGrading.enrollments.statusFor", { name })}
                            options={[
                              { value: "default", label: defaultLabel },
                              {
                                value: "enrolled",
                                label: t("academicGrading.enrollments.enrolled"),
                              },
                              { value: "exempt", label: t("academicGrading.enrollments.exempt") },
                            ]}
                            value={choice}
                            disabled={setEnrollment.isPending}
                            onChange={(next) => {
                              if (next === choice) return;
                              if (next === "exempt")
                                setExempting({ studentId: student.student_id, name });
                              else
                                apply(student.student_id, next === "default" ? "none" : "enrolled");
                            }}
                          />
                        ) : choice === "default" ? (
                          defaultLabel
                        ) : (
                          t(`academicGrading.enrollments.${choice}`)
                        )}
                      </Table.Cell>
                      <Table.Cell>{record?.reason ?? "—"}</Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          ) : null}
        </>
      )}
      {exempting && subject ? (
        <ReasonModal
          key={`${exempting.studentId}-${subject.subject_id}`}
          open
          title={t("academicGrading.enrollments.exemptTitle", {
            name: exempting.name,
            subject: subject.subject_name,
          })}
          description={t("academicGrading.enrollments.exemptDescription")}
          confirmLabel={t("academicGrading.enrollments.exemptConfirm")}
          submitting={setEnrollment.isPending}
          onCancel={() => setExempting(null)}
          onConfirm={(reason) => apply(exempting.studentId, "exempt", reason)}
        />
      ) : null}
    </section>
  );
}
