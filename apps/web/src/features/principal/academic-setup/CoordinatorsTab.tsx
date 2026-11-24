import { Button, Checkbox, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { useSubjects, useTeacherContacts } from "../school/queries";
import { useGradeLevels } from "../sections/queries";

import { Badge, ConfirmModal } from "./components";
import { problemMessage } from "./errors";
import {
  useCreateSubjectCoordinator,
  useDeleteSubjectCoordinator,
  useSubjectCoordinators,
  useUpdateSubjectCoordinator,
} from "./subject-coordinators";

import type { SetupContext } from "./context";
import type { SubjectCoordinator } from "./subject-coordinators";

/**
 * Subject coordinators for the selected year (000261): a teacher (or other staff member) who
 * coordinates a subject across every section of the grades they cover. Coordinating is not a role:
 * it lets them read those sections' marks, predicted grades and results in the mobile app,
 * read-only. Leadership (academicConfig:manage) assigns, narrows and removes them.
 */
export function CoordinatorsTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const canEdit = ctx.can.manage;
  const coordinators = useSubjectCoordinators(ctx.year.id);
  const remove = useDeleteSubjectCoordinator();
  const [editing, setEditing] = useState<{ coordinator: SubjectCoordinator | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SubjectCoordinator | null>(null);

  return (
    <section className="ag-block" aria-labelledby="ag-coordinators-heading">
      <div className="ag-head">
        <h2 id="ag-coordinators-heading">{t("academicGrading.coordinators.heading")}</h2>
        {canEdit ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setEditing({ coordinator: null })}
          >
            {t("academicGrading.coordinators.add")}
          </Button>
        ) : null}
      </div>
      <p className="ag-muted">{t("academicGrading.coordinators.help", { year: ctx.year.name })}</p>
      <Table caption={t("academicGrading.coordinators.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.coordinators.columns.subject")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.coordinators.columns.person")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.coordinators.columns.grades")}</Table.HeaderCell>
            {canEdit ? (
              <Table.HeaderCell>
                {t("academicGrading.coordinators.columns.actions")}
              </Table.HeaderCell>
            ) : null}
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={canEdit ? 4 : 3}
          loading={coordinators.isPending}
          empty={
            coordinators.isError
              ? problemMessage(coordinators.error, t)
              : t("academicGrading.coordinators.empty")
          }
        >
          {(coordinators.data ?? []).map((coordinator) => (
            <Table.Row key={coordinator.id}>
              <Table.Cell>
                <strong>{coordinator.subject_name}</strong>{" "}
                <span className="ag-muted">{coordinator.subject_code}</span>
              </Table.Cell>
              <Table.Cell>{coordinator.user_name}</Table.Cell>
              <Table.Cell>
                {coordinator.grade_levels.length === 0 ? (
                  <Badge tone="info">{t("academicGrading.coordinators.allGrades")}</Badge>
                ) : (
                  coordinator.grade_levels.map((grade) => grade.name).join(", ")
                )}
              </Table.Cell>
              {canEdit ? (
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={t("academicGrading.coordinators.editLabel", {
                        name: coordinator.user_name,
                        subject: coordinator.subject_name,
                      })}
                      onClick={() => setEditing({ coordinator })}
                    >
                      {t("academicGrading.common.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("academicGrading.coordinators.removeLabel", {
                        name: coordinator.user_name,
                        subject: coordinator.subject_name,
                      })}
                      onClick={() => setPendingDelete(coordinator)}
                    >
                      {t("academicGrading.common.remove")}
                    </Button>
                  </div>
                </Table.Cell>
              ) : null}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {editing ? (
        <CoordinatorModal
          ctx={ctx}
          coordinator={editing.coordinator}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmModal
        open={pendingDelete !== null}
        title={t("academicGrading.coordinators.removeTitle", {
          name: pendingDelete?.user_name ?? "",
          subject: pendingDelete?.subject_name ?? "",
        })}
        description={t("academicGrading.coordinators.removeDescription")}
        confirmLabel={t("academicGrading.common.remove")}
        submitting={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSuccess: () => {
              show({ variant: "success", title: t("academicGrading.coordinators.removed") });
              setPendingDelete(null);
            },
            onError: (error) => {
              show({
                variant: "error",
                title: t("academicGrading.coordinators.removeFailed"),
                description: problemMessage(error, t),
              });
              setPendingDelete(null);
            },
          })
        }
      />
    </section>
  );
}

/** Add a coordinator (subject, person, grades), or change an existing one's grades. */
function CoordinatorModal({
  ctx,
  coordinator,
  onClose,
}: {
  ctx: SetupContext;
  coordinator: SubjectCoordinator | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const subjects = useSubjects(coordinator === null);
  const staff = useTeacherContacts();
  const grades = useGradeLevels();
  const create = useCreateSubjectCoordinator();
  const update = useUpdateSubjectCoordinator();
  const saving = create.isPending || update.isPending;
  const failure = create.error ?? update.error;
  const [subjectId, setSubjectId] = useState<string | undefined>(coordinator?.subject_id);
  const [userId, setUserId] = useState<string | undefined>(coordinator?.user_id);
  const [gradeLevelIds, setGradeLevelIds] = useState<string[]>(
    coordinator?.grade_levels.map((grade) => grade.id) ?? [],
  );

  function toggle(id: string, checked: boolean) {
    setGradeLevelIds((prev) =>
      checked ? [...prev, id] : prev.filter((gradeId) => gradeId !== id),
    );
  }

  function saved() {
    show({ variant: "success", title: t("academicGrading.coordinators.saved") });
    onClose();
  }

  function submit() {
    if (coordinator) {
      update.mutate({ coordinatorId: coordinator.id, gradeLevelIds }, { onSuccess: saved });
      return;
    }
    if (!subjectId || !userId) return;
    create.mutate(
      {
        yearId: ctx.year.id,
        body: { subject_id: subjectId, user_id: userId, grade_level_ids: gradeLevelIds },
      },
      { onSuccess: saved },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        coordinator
          ? t("academicGrading.coordinators.editTitle", {
              name: coordinator.user_name,
              subject: coordinator.subject_name,
            })
          : t("academicGrading.coordinators.addTitle", { year: ctx.year.name })
      }
    >
      <Modal.Body>
        {coordinator ? null : (
          <div className="ag-grid ag-grid--dense">
            <Select
              label={t("academicGrading.coordinators.subject")}
              options={(subjects.data ?? []).map((subject) => ({
                value: subject.id,
                label: subject.name,
              }))}
              value={subjectId}
              onChange={setSubjectId}
              placeholder={
                subjects.isPending
                  ? t("academicGrading.common.loading")
                  : t("academicGrading.coordinators.pickSubject")
              }
              required
            />
            <Select
              label={t("academicGrading.coordinators.person")}
              options={(staff.data ?? []).map((teacher) => ({
                value: teacher.user_id,
                label: teacher.display_name,
              }))}
              value={userId}
              onChange={setUserId}
              placeholder={
                staff.isPending
                  ? t("academicGrading.common.loading")
                  : t("academicGrading.coordinators.pickPerson")
              }
              required
            />
          </div>
        )}
        <fieldset className="ag-fieldset">
          <legend>{t("academicGrading.coordinators.gradesLegend")}</legend>
          <p className="ag-muted">{t("academicGrading.coordinators.gradesHelp")}</p>
          <div className="ag-checks">
            {(grades.data ?? []).map((grade) => (
              <Checkbox
                key={grade.id}
                label={grade.name}
                checked={gradeLevelIds.includes(grade.id)}
                onChange={(event) => toggle(grade.id, event.target.checked)}
              />
            ))}
          </div>
        </fieldset>
        {failure ? (
          <p className="ag-error" role="alert">
            {problemMessage(failure, t)}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.cancel")}
        </Button>
        <Button
          type="button"
          loading={saving}
          disabled={coordinator === null && (!subjectId || !userId)}
          onClick={submit}
        >
          {t("academicGrading.coordinators.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
