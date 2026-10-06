import { PERMISSIONS } from "@studafy/constants";
import { Table } from "@studafy/ui";
import { useQueryClient } from "@tanstack/react-query";

import { ExportCsvButton } from "../../../components/ExportCsvButton";
import { ImportCsvButton } from "../../../components/ImportCsvButton";
import { api } from "../../../lib/api";
import { usePermissions } from "../../../lib/auth";
import { allRows } from "../../../lib/data-transfer";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import {
  CLASSES_KEY_ROOT,
  useClassesForTerm,
  useCourses,
  useEnrollmentCounts,
  useRooms,
  useTeacherContacts,
} from "../school/queries";
import { TermPicker, useTermSelection } from "../school/TermPicker";

import type { ExportColumn, ImportSpec } from "../../../lib/data-transfer";
import type { Class, Room, TeacherContact, Term } from "../../admin/timetable/queries";
import type { Course } from "../school/queries";
import type { components } from "@studafy/api-client";
import type { TFunction } from "i18next";

import "../school/principal-school.css";

type CreateClassInput = components["schemas"]["CreateClassBody"];

const COLUMN_COUNT = 5;
const CLASS_STATUSES = ["planned", "active", "completed", "cancelled"] as const;

interface ClassImportLookups {
  /** Terms of the year selected on the page; a CSV term is matched by code or name among these. */
  terms: readonly Term[];
  /** The page's selected term, used when a row leaves `term` blank. */
  defaultTerm: Term | undefined;
  courses: readonly Course[];
  teachers: readonly TeacherContact[];
  rooms: readonly Room[];
}

/** Case-insensitive lookup of `value` against one or more keys of each item. */
function findBy<T>(items: readonly T[], value: string, keys: (item: T) => readonly string[]) {
  const needle = value.trim().toLowerCase();
  return items.find((item) => keys(item).some((key) => key.toLowerCase() === needle));
}

/**
 * CSV import of classes. References are written the way a person knows them — course code, term
 * code or name (within the selected year; blank = the selected term), teacher employee number,
 * room code — and resolved to ids here against lookups loaded before the dialog opens. An unknown
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
        key: "room",
        label: t("principal.classes.import.fields.room"),
        required: true,
        example: lookups.rooms[0]?.code ?? "R101",
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
      const room = findBy(lookups.rooms, String(values.room), (item) => [item.code]);
      if (!room) errors.push(t("principal.classes.import.unknownRoom", { value: values.room }));
      const capacity = typeof values.capacity === "number" ? values.capacity : null;
      if (capacity !== null && capacity < 1) errors.push(t("principal.classes.import.capacityMin"));
      if (errors.length > 0 || !course || !term || !teacher || !room) return { errors };
      return {
        code: String(values.code),
        course_id: course.id,
        academic_year_id: term.academic_year_id,
        term_id: term.id,
        lead_teacher_id: teacher.id,
        room_id: room.id,
        capacity,
        status: typeof values.status === "string" ? (values.status as Class["status"]) : "planned",
      };
    },
    create: (body) => api.POST("/api/academics/classes", { body }),
  };
}

/**
 * Classes (`/portal/principal/classes`): every class running in the chosen term with its lead
 * teacher, room, and how full it is (active enrolments against capacity). Classes are set up by the
 * admin; the CSV import is offered to holders of `course:create` (the class create route itself
 * has no dedicated permission), and creates into the selected year.
 */
export default function PrincipalClassesPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const queryClient = useQueryClient();
  const canImport = usePermissions().has(PERMISSIONS.COURSE_CREATE);
  const selection = useTermSelection();
  const classes = useClassesForTerm(selection.term?.id);
  const teachers = useTeacherContacts();
  const rooms = useRooms();
  const courses = useCourses(canImport);

  const classList = [...(classes.data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const enrolled = useEnrollmentCounts(classList.map((klass) => klass.id));
  const teacherName = new Map(
    (teachers.data ?? []).map((teacher) => [teacher.id, teacher.display_name]),
  );
  const roomName = new Map((rooms.data ?? []).map((room) => [room.id, room.name]));

  const exportColumns: ExportColumn<Class>[] = [
    { header: t("principal.classes.columns.class"), value: (klass) => klass.code },
    {
      header: t("principal.classes.columns.teacher"),
      value: (klass) => teacherName.get(klass.lead_teacher_id) ?? "",
    },
    {
      header: t("principal.classes.columns.room"),
      value: (klass) => roomName.get(klass.room_id) ?? "",
    },
    { header: t("principal.classes.columns.enrolled"), value: (klass) => enrolled.get(klass.id) },
    { header: t("principal.classes.capacity"), value: (klass) => klass.capacity },
    {
      header: t("principal.classes.columns.status"),
      value: (klass) => t(`principal.classes.status.${klass.status}`, klass.status),
    },
  ];
  const lookupsReady =
    !selection.isPending && teachers.isSuccess && rooms.isSuccess && courses.isSuccess;

  return (
    <>
      <h1>{t("principal.classes.title")}</h1>
      <p>{t("principal.classes.description")}</p>

      <div className="principal-school__filters">
        <TermPicker selection={selection} />
        <div className="principal-school__actions">
          <ExportCsvButton
            filename="classes"
            columns={exportColumns}
            getRows={() => Promise.resolve(allRows(classList))}
            disabled={selection.isPending || classes.isPending}
          />
          {canImport ? (
            <ImportCsvButton
              spec={classImportSpec(t, {
                terms: selection.terms,
                defaultTerm: selection.term,
                courses: courses.data ?? [],
                teachers: teachers.data ?? [],
                rooms: rooms.data ?? [],
              })}
              title={t("principal.classes.import.title")}
              onImported={() => void queryClient.invalidateQueries({ queryKey: CLASSES_KEY_ROOT })}
              disabled={!lookupsReady}
            />
          ) : null}
        </div>
      </div>

      <Table caption={t("principal.classes.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.classes.columns.class")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.teacher")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.room")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.enrolled")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.classes.columns.status")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
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
                <Table.Cell>{roomName.get(klass.room_id) ?? "—"}</Table.Cell>
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
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </>
  );
}
