import { api } from "../../../lib/api";

import type { CreateSlotBody } from "./mutations";
import type { Class, TeacherContact } from "./queries";
import type { ImportSpec } from "../../../lib/data-transfer";
import type { TFunction } from "i18next";

export interface SlotImportContext {
  /** The draft version the lessons are added to. */
  versionId: string;
  /** Classes of the version's term; a CSV class is matched by code among these. */
  classes: readonly Class[];
  teachers: readonly TeacherContact[];
  /** The school week (`GET /api/academics/timetable-settings`): days 1=Mon..7=Sun and periods. */
  schoolDays: readonly number[];
  periodsPerDay: number;
}

/** Case-insensitive lookup of `value` against one key of each item. */
function findBy<T>(
  items: readonly T[],
  value: string,
  key: (item: T) => string | null | undefined,
) {
  const needle = value.trim().toLowerCase();
  return items.find((item) => key(item)?.toLowerCase() === needle);
}

/**
 * CSV import of lessons into a draft timetable. References are written the way a person knows
 * them — class code and teacher employee number — and resolved to ids against the lookups the
 * workspace already holds. Day and period are checked against the school week here; teacher clashes
 * are left to the API, which rejects the row with its own message.
 */
export function slotImportSpec(
  t: TFunction,
  context: SlotImportContext,
): ImportSpec<CreateSlotBody> {
  return {
    templateName: "timetable-lessons",
    fields: [
      {
        key: "day",
        label: t("adminSchool.timetable.import.fields.day"),
        required: true,
        type: "integer",
        example: String(context.schoolDays[0] ?? 1),
      },
      {
        key: "period",
        label: t("adminSchool.timetable.import.fields.period"),
        required: true,
        type: "integer",
        example: "1",
      },
      {
        key: "class",
        label: t("adminSchool.timetable.import.fields.class"),
        required: true,
        example: context.classes[0]?.code ?? "MATH101-A",
      },
      {
        key: "teacher",
        label: t("adminSchool.timetable.import.fields.teacher"),
        required: true,
        example: context.teachers[0]?.employee_number ?? "T-001",
      },
    ],
    toRecord: (values) => {
      const errors: string[] = [];
      const weekday = values.day as number;
      if (!context.schoolDays.includes(weekday)) {
        errors.push(t("adminSchool.timetable.import.dayNotInWeek", { value: weekday }));
      }
      const period = values.period as number;
      if (period < 1 || period > context.periodsPerDay) {
        errors.push(t("adminSchool.timetable.import.periodRange", { max: context.periodsPerDay }));
      }
      const klass = findBy(context.classes, String(values.class), (item) => item.code);
      if (!klass) {
        errors.push(t("adminSchool.timetable.import.unknownClass", { value: values.class }));
      }
      const teacher = findBy(
        context.teachers,
        String(values.teacher),
        (item) => item.employee_number,
      );
      if (!teacher) {
        errors.push(t("adminSchool.timetable.import.unknownTeacher", { value: values.teacher }));
      }
      if (errors.length > 0 || !klass || !teacher) return { errors };
      return {
        weekday,
        period,
        class_id: klass.id,
        teacher_id: teacher.id,
      };
    },
    create: async (body) => {
      const { data } = await api.POST("/api/academics/timetable-versions/{versionId}/slots", {
        params: { path: { versionId: context.versionId } },
        body,
      });
      if (!data) throw new Error("Slot creation returned no data.");
      return data;
    },
  };
}
