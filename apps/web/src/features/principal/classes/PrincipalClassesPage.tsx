import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Modal, Table, useToast } from "@studafy/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ImportCsvButton } from "../../../components/ImportCsvButton";
import { LinkButton } from "../../../components/LinkButton";
import { api } from "../../../lib/api";
import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import {
  CLASSES_KEY_ROOT,
  useClassesForTerm,
  useCourses,
  useEnrollmentCounts,
  useTeacherContacts,
} from "../school/queries";
import { TermPicker, useTermSelection } from "../school/TermPicker";
import { sectionDisplayName, useSections } from "../sections/queries";

import { CLASS_STATUSES, ClassFormModal } from "./ClassFormModal";
import { useDeleteClass } from "./mutations";

import type { ImportSpec } from "../../../lib/data-transfer";
import type { Class, TeacherContact, Term } from "../../admin/timetable/queries";
import type { Course } from "../school/queries";
import type { components } from "@studafy/api-client";
import type { TFunction } from "i18next";

import "../school/principal-school.css";

type CreateClassInput = components["schemas"]["CreateClassBody"];

/** Class, teacher, section, enrolled, status — plus the row actions for `timetable:manage`. */
const COLUMN_COUNT = 5;

interface ClassImportLookups {
  /** Terms of the year selected on the page; a CSV term is matched by code or name among these. */
  terms: readonly Term[];
  /** The page's selected term, used when a row leaves `term` blank. */
  defaultTerm: Term | undefined;
  courses: readonly Course[];
  teachers: readonly TeacherContact[];
}

/** Case-insensitive lookup of `value` against one or more keys of each item. */
function findBy<T>(items: readonly T[], value: string, keys: (item: T) => readonly string[]) {
  const needle = value.trim().toLowerCase();
  return items.find((item) => keys(item).some((key) => key.toLowerCase() === needle));
}

/**
 * CSV import of classes. References are written the way a person knows them — course code, term
 * code or name (within the selected year; blank = the selected term), teacher employee number —
 * and resolved to ids here against lookups loaded before the dialog opens. An unknown
 * reference rejects the row with a message naming the value.
 */
function classImportSpec(t: TFunction, lookups: ClassImportLookups): ImportSpec<CreateClassInput> {
  return {
    templateName: "classes",
    fields: [
      {
        key: "code",
        label: t("principal.classes.import.fields.code"),
        required: true,
        maxLength: 50,
        example: "MATH101-A",
      },
      {
        key: "course",
        label: t("principal.classes.import.fields.course"),
        required: true,
        example: lookups.courses[0]?.code ?? "MATH101",
      },
      {
        key: "term",
        label: t("principal.classes.import.fields.term"),
        example: lookups.defaultTerm?.code ?? "",
      },
      {
        key: "teacher",
        label: t("principal.classes.import.fields.teacher"),
        required: true,
        example: lookups.teachers[0]?.employee_number ?? "T-001",
      },
      {
        key: "capacity",
        label: t("principal.classes.import.fields.capacity"),
        type: "integer",
        example: "30",
      },
      {
        key: "status",
        label: t("principal.classes.import.fields.status"),
        options: CLASS_STATUSES,
        example: "planned",
      },
    ],
    toRecord: (values) => {
      const errors: string[] = [];
      const course = findBy(lookups.courses, String(values.course), (item) => [item.code]);
      if (!course) {
        errors.push(t("principal.classes.import.unknownCourse", { value: values.course }));
      }
      const term =
        typeof values.term === "string"
          ? findBy(lookups.terms, values.term, (item) => [item.code, item.name])
          : lookups.defaultTerm;
      if (!term) {
        errors.push(
          typeof values.term === "string"
            ? t("principal.classes.import.unknownTerm", { value: values.term })
            : t("principal.classes.import.noTerm"),
        );
      }
      const teacher = findBy(lookups.teachers, String(values.teacher), (item) => [
        item.employee_number,
      ]);
      if (!teacher) {
        errors.push(t("principal.classes.import.unknownTeacher", { value: values.teacher }));
      }
      const capacity = typeof values.capacity === "number" ? values.capacity : null;
      if (capacity !== null && capacity < 1) errors.push(t("principal.classes.import.capacityMin"));
      if (errors.length > 0 || !course || !term || !teacher) return { errors };
      return {
        code: String(values.code),
        course_id: course.id,
        academic_year_id: term.academic_year_id,
        term_id: term.id,
        lead_teacher_id: teacher.id,
        capacity,
        status: typeof values.status === "string" ? (values.status as Class["status"]) : "planned",
      };
    },
    create: (body) => api.POST("/api/academics/classes", { body }),
  };
}

/**
 * Classes (`/portal/principal/classes`): every class running in the chosen term with its lead
 * teacher, grade section, and how full it is (active enrolments against capacity). Holders of
 * `timetable:manage` (ORG_ADMIN and PRINCIPAL — the permission every class write requires) can add
 * a class, edit one (teacher, section, code, capacity, status), remove one, add a course for it,
 * and import classes from CSV into the selected year.
 */
export default function PrincipalClassesPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const { show } = useToast();
  const canManage = permissions.has(PERMISSIONS.TIMETABLE_MANAGE);
  const selection = useTermSelection();
  const sections = useSections(selection.year?.id);
  const [form, setForm] = useState<{ klass: Class | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Class | null>(null);
  const deleteClass = useDeleteClass();
  const classes = useClassesForTerm(selection.term?.id);
  const teachers = useTeacherContacts();
  const courses = useCourses(canManage);
  const columnCount = canManage ? COLUMN_COUNT + 1 : COLUMN_COUNT;

  const classList = [...(classes.data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const enrolled = useEnrollmentCounts(classList.map((klass) => klass.id));
  const teacherName = new Map(
    (teachers.data ?? []).map((teacher) => [teacher.id, teacher.display_name]),
  );
  const sectionName = new Map(
    (sections.data ?? []).map((section) => [section.id, sectionDisplayName(section, t)]),
  );

  const lookupsReady = !selection.isPending && teachers.isSuccess && courses.isSuccess;

  function confirmDelete() {
    if (!pendingDelete) return;
    deleteClass.mutate(pendingDelete.id, {
      onSuccess: () => {
        show({ variant: "success", title: t("principal.classes.delete.deleted") });
        setPendingDelete(null);
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("principal.classes.delete.failed"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
        setPendingDelete(null);
      },
    });
  }

  return (
    <>
      <div className="principal-school__header">
        <h1>{t("principal.classes.title")}</h1>
        {canManage ? (
          <LinkButton href="/portal/principal/sections" variant="secondary">
            {t("principal.classes.sectionsLink")}
          </LinkButton>
        ) : null}
      </div>
      <p>{t("principal.classes.description")}</p>

      <div className="principal-school__filters">
        <TermPicker selection={selection} />
        <div className="principal-school__actions">
          {canManage ? (
            <ImportCsvButton
              spec={classImportSpec(t, {
                terms: selection.terms,
                defaultTerm: selection.term,
                courses: courses.data ?? [],
                teachers: teachers.data ?? [],
              })}
              title={t("principal.classes.import.title")}
              onImported={() => void queryClient.invalidateQueries({ queryKey: CLASSES_KEY_ROOT })}
              disabled={!lookupsReady}
            />
          ) : null}
          {canManage ? (
            <Button type="button" onClick={() => setForm({ klass: null })}>
              {t("principal.classes.add")}
            </Button>
          ) : null}
        </div>
      </div>

      <Table caption={t("principal.classes.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.classes.columns.class")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.teacher")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.section")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.enrolled")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.status")}</Table.HeaderCell>
            {canManage ? (
              <Table.HeaderCell>{t("principal.classes.columns.actions")}</Table.HeaderCell>
            ) : null}
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={columnCount}
          loading={selection.isPending || classes.isPending}
          empty={classes.isError ? t("principal.classes.error") : t("principal.school.noClasses")}
        >
          {classList.map((klass) => {
            const count = enrolled.get(klass.id);
            const countText = count === undefined ? "…" : formatNumber(count);
            return (
              <Table.Row key={klass.id}>
                <Table.Cell>{klass.code}</Table.Cell>
                <Table.Cell>{teacherName.get(klass.lead_teacher_id) ?? "—"}</Table.Cell>
                <Table.Cell>
                  {klass.section_id === null
                    ? "—"
                    : (sectionName.get(klass.section_id) ?? (sections.isPending ? "…" : "—"))}
                </Table.Cell>
                <Table.Cell>
                  {klass.capacity === null
                    ? countText
                    : t("principal.classes.ofCapacity", {
                        enrolled: countText,
                        capacity: formatNumber(klass.capacity),
                      })}
                </Table.Cell>
                <Table.Cell>
                  {t(`principal.classes.status.${klass.status}`, klass.status)}
                </Table.Cell>
                {canManage ? (
                  <Table.Cell>
                    <div className="principal-school__cell-action">
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("principal.classes.editLabel", { code: klass.code })}
                        onClick={() => setForm({ klass })}
                      >
                        {t("principal.classes.edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("principal.classes.delete.label", { code: klass.code })}
                        onClick={() => setPendingDelete(klass)}
                      >
                        {t("principal.classes.delete.action")}
                      </Button>
                    </div>
                  </Table.Cell>
                ) : null}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>

      {canManage ? (
        <ClassFormModal
          open={form !== null}
          klass={form?.klass ?? null}
          years={selection.years}
          defaultYearId={selection.year?.id}
          defaultTermId={selection.term?.id}
          onClose={() => setForm(null)}
        />
      ) : null}

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t("principal.classes.delete.title", { code: pendingDelete?.code ?? "" })}
        description={t("principal.classes.delete.description")}
      >
        <Modal.Footer>
          <Button type="button" variant="secondary" onClick={() => setPendingDelete(null)}>
            {t("principal.common.cancel")}
          </Button>
          <Button type="button" loading={deleteClass.isPending} onClick={confirmDelete}>
            {t("principal.classes.delete.confirm")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
