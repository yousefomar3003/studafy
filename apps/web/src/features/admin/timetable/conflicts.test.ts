// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { findLocalConflict, findSectionClash } from "./conflicts";
import { compactSectionLabel } from "./queries";

import type { TimetableSlot } from "./queries";

function makeSlot(overrides: Partial<TimetableSlot> & Pick<TimetableSlot, "id">): TimetableSlot {
  return {
    school_id: "school-1",
    timetable_version_id: "version-1",
    class_id: "class-1",
    teacher_id: "teacher-1",
    room_id: null,
    section_id: null,
    section_name: null,
    grade_level_name: null,
    weekday: 1,
    period: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const classCode = (id: string) => (id === "class-1" ? "MATH-101" : `class-${id}`);
const teacherName = (id: string) => (id === "teacher-1" ? "Ms. Chen" : `teacher-${id}`);

describe("findLocalConflict", () => {
  test("returns null when the cell is unoccupied", () => {
    const conflict = findLocalConflict(
      [],
      { teacher_id: "teacher-1", weekday: 1, period: 1 },
      classCode,
      teacherName,
    );
    expect(conflict).toBeNull();
  });

  test("returns null when the same weekday/period is used by a different teacher", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 1, period: 1 })];
    const conflict = findLocalConflict(
      slots,
      { teacher_id: "teacher-2", weekday: 1, period: 1 },
      classCode,
      teacherName,
    );
    expect(conflict).toBeNull();
  });

  test("flags a teacher already booked in the same weekday/period", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 1, period: 1, teacher_id: "teacher-1" })];
    const conflict = findLocalConflict(
      slots,
      { teacher_id: "teacher-1", weekday: 1, period: 1 },
      classCode,
      teacherName,
    );
    expect(conflict?.conflictType).toBe("teacher");
    expect(conflict?.existingSlot.id).toBe("slot-1");
    expect(conflict?.message).toBe(
      'Teacher "Ms. Chen" is already scheduled for class "MATH-101" on Monday, period 1.',
    );
  });

  test("ignores a different weekday or period", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 1, period: 1, teacher_id: "teacher-1" })];
    expect(
      findLocalConflict(
        slots,
        { teacher_id: "teacher-1", weekday: 2, period: 1 },
        classCode,
        teacherName,
      ),
    ).toBeNull();
    expect(
      findLocalConflict(
        slots,
        { teacher_id: "teacher-1", weekday: 1, period: 2 },
        classCode,
        teacherName,
      ),
    ).toBeNull();
  });

  test("excludes the slot being edited from its own collision check", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 1, period: 1, teacher_id: "teacher-1" })];
    const conflict = findLocalConflict(
      slots,
      {
        teacher_id: "teacher-1",
        weekday: 1,
        period: 1,
        excludeSlotId: "slot-1",
      },
      classCode,
      teacherName,
    );
    expect(conflict).toBeNull();
  });
});

describe("findSectionClash", () => {
  const sectionSlot = makeSlot({
    id: "slot-1",
    weekday: 1,
    period: 1,
    section_id: "sec-10c",
    section_name: "C",
    grade_level_name: "Grade 10",
  });

  test("flags a section already having a lesson at the same weekday/period", () => {
    const clash = findSectionClash(
      [sectionSlot],
      { section_id: "sec-10c", weekday: 1, period: 1 },
      classCode,
    );
    expect(clash?.existingSlot.id).toBe("slot-1");
    expect(clash?.message).toBe(
      'Section "Grade 10 – C" also has class "MATH-101" on Monday, period 1. The lesson was saved — check this is intended.',
    );
  });

  test("never flags a class without a section", () => {
    const unsectioned = makeSlot({ id: "slot-1", weekday: 1, period: 1 });
    expect(
      findSectionClash([unsectioned], { section_id: null, weekday: 1, period: 1 }, classCode),
    ).toBeNull();
  });

  test("ignores another section, another time, and the slot being edited", () => {
    expect(
      findSectionClash([sectionSlot], { section_id: "sec-11a", weekday: 1, period: 1 }, classCode),
    ).toBeNull();
    expect(
      findSectionClash([sectionSlot], { section_id: "sec-10c", weekday: 1, period: 2 }, classCode),
    ).toBeNull();
    expect(
      findSectionClash(
        [sectionSlot],
        { section_id: "sec-10c", weekday: 1, period: 1, excludeSlotId: "slot-1" },
        classCode,
      ),
    ).toBeNull();
  });
});

describe("compactSectionLabel", () => {
  test("uses the grade's number when its name has one", () => {
    expect(compactSectionLabel("Grade 10", "C")).toBe("10-C");
  });

  test("falls back to the whole grade name, and to nothing without a section", () => {
    expect(compactSectionLabel("الصف العاشر", "ج")).toBe("الصف العاشر-ج");
    expect(compactSectionLabel(null, null)).toBeNull();
  });
});
