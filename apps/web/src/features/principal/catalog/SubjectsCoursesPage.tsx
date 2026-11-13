import { ApiError } from "@studafy/api-client";
import { Button, Modal, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { AddCourseModal } from "../classes/AddCourseModal";
import { useCourses, useSubjects } from "../school/queries";

import { CatalogItemModal } from "./CatalogItemModal";
import { useDeleteCourse, useDeleteSubject } from "./mutations";

import type { CatalogItem } from "./CatalogItemModal";

import "../school/principal-school.css";
import "../sections/sections.css";
import "../years/years.css";
import "./catalog.css";

const COLUMN_COUNT = 5;

/**
 * Subjects & courses (`/portal/principal/catalog`), gated on `timetable:manage`: the school's
 * course catalog, every subject with the courses under it. Classes are built from these courses on
 * the Classes page. A subject or course can be renamed, recoded and given a status; removing one
 * that is still used (a subject with courses, a course with classes) archives it instead, so no
 * class or grade loses what it was taught under.
 */
export default function SubjectsCoursesPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const subjects = useSubjects();
  const courses = useCourses();
  const deleteSubject = useDeleteSubject();
  const deleteCourse = useDeleteCourse();
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [removing, setRemoving] = useState<CatalogItem | null>(null);
  const [adding, setAdding] = useState(false);

  const subjectList = [...(subjects.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const coursesBySubject = new Map<string, NonNullable<typeof courses.data>>();
  for (const course of courses.data ?? []) {
    const list = coursesBySubject.get(course.subject_id) ?? [];
    list.push(course);
    coursesBySubject.set(course.subject_id, list);
  }

  function confirmRemove() {
    if (!removing) return;
    const onSuccess = () => {
      show({ variant: "success", title: t("principal.catalog.remove.done") });
      setRemoving(null);
    };
    const onError = (error: unknown) => {
      show({
        variant: "error",
        title: t("principal.catalog.remove.failed"),
        description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
      });
      setRemoving(null);
    };
    if (removing.kind === "subject") {
      deleteSubject.mutate(removing.item.id, { onSuccess, onError });
    } else {
      deleteCourse.mutate(removing.item.id, { onSuccess, onError });
    }
  }

  const rowActions = (target: CatalogItem) => (
    <div className="sections-page__row-actions">
      <Button
        type="button"
        variant="tertiary"
        aria-label={t("principal.catalog.editLabel", { name: target.item.name })}
        onClick={() => setEditing(target)}
      >
        {t("principal.catalog.edit")}
      </Button>
      {target.item.status !== "archived" ? (
        <Button
          type="button"
          variant="tertiary"
          aria-label={t("principal.catalog.removeLabel", { name: target.item.name })}
          onClick={() => setRemoving(target)}
        >
          {t("principal.catalog.remove.action")}
        </Button>
      ) : null}
    </div>
  );

  const loading = subjects.isPending || courses.isPending;

  return (
    <>
      <div className="principal-school__header">
        <h1>{t("principal.catalog.title")}</h1>
        <Button type="button" onClick={() => setAdding(true)}>
          {t("principal.catalog.addCourse")}
        </Button>
      </div>
      <p>{t("principal.catalog.description")}</p>

      <Table caption={t("principal.catalog.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.catalog.columns.name")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.catalog.columns.code")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.catalog.columns.credits")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.catalog.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.catalog.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={loading}
          empty={
            subjects.isError || courses.isError
              ? t("principal.catalog.error")
              : t("principal.catalog.empty")
          }
        >
          {subjectList.flatMap((subject) => [
            <Table.Row key={subject.id}>
              <Table.Cell>
                <strong>{subject.name}</strong>
              </Table.Cell>
              <Table.Cell>{subject.code}</Table.Cell>
              <Table.Cell>
                {t("principal.catalog.courseCount", {
                  count: coursesBySubject.get(subject.id)?.length ?? 0,
                })}
              </Table.Cell>
              <Table.Cell>
                <span className="years-page__status" data-status={subject.status}>
                  {t(`principal.catalog.status.${subject.status}`)}
                </span>
              </Table.Cell>
              <Table.Cell>{rowActions({ kind: "subject", item: subject })}</Table.Cell>
            </Table.Row>,
            ...[...(coursesBySubject.get(subject.id) ?? [])]
              .sort((a, b) => a.code.localeCompare(b.code))
              .map((course) => (
                <Table.Row key={course.id}>
                  <Table.Cell>
                    <span className="catalog-page__course">{course.name}</span>
                  </Table.Cell>
                  <Table.Cell>{course.code}</Table.Cell>
                  <Table.Cell>{formatNumber(course.credit_hours)}</Table.Cell>
                  <Table.Cell>
                    <span className="years-page__status" data-status={course.status}>
                      {t(`principal.catalog.status.${course.status}`)}
                    </span>
                  </Table.Cell>
                  <Table.Cell>{rowActions({ kind: "course", item: course })}</Table.Cell>
                </Table.Row>
              )),
          ])}
        </Table.Body>
      </Table>

      <CatalogItemModal target={editing} onClose={() => setEditing(null)} />
      <AddCourseModal open={adding} onClose={() => setAdding(false)} onCreated={() => undefined} />

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t("principal.catalog.remove.title", { name: removing?.item.name })}
      >
        <Modal.Body>
          <p>
            {removing?.kind === "subject"
              ? t("principal.catalog.remove.subjectBody")
              : t("principal.catalog.remove.courseBody")}
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={() => setRemoving(null)}>
            {t("principal.common.cancel")}
          </Button>
          <Button
            type="button"
            loading={deleteSubject.isPending || deleteCourse.isPending}
            onClick={confirmRemove}
          >
            {t("principal.catalog.remove.action")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
