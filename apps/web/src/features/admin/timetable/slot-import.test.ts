// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { prepareImport } from "../../../lib/data-transfer";

import { slotImportSpec } from "./slot-import";

import type { Class, TeacherContact } from "./queries";
import type { TFunction } from "i18next";

const t = ((key: string) => key) as unknown as TFunction;

const spec = slotImportSpec(t, {
  versionId: "version-1",
  classes: [{ id: "class-1", code: "MATH101-A" } as Class],
  teachers: [{ id: "teacher-1", employee_number: "T-001" } as TeacherContact],
  schoolDays: [7, 1, 2, 3, 4],
  periodsPerDay: 8,
});

describe("slotImportSpec", () => {
  test("resolves codes to ids, case-insensitively", () => {
    const result = prepareImport("day,period,class,teacher\n1,2,math101-a,t-001", spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]?.record).toEqual({
      weekday: 1,
      period: 2,
      class_id: "class-1",
      teacher_id: "teacher-1",
    });
  });

  test("rejects days outside the school week, out-of-range periods and unknown references", () => {
    const result = prepareImport("day,period,class,teacher\n5,9,X,Y", spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.rows[0];
    expect(row?.record).toBeNull();
    expect(row?.issues.map((issue) => issue.message)).toEqual([
      "adminSchool.timetable.import.dayNotInWeek",
      "adminSchool.timetable.import.periodRange",
      "adminSchool.timetable.import.unknownClass",
      "adminSchool.timetable.import.unknownTeacher",
    ]);
  });
});
