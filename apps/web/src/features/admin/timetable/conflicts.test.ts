// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { findLocalConflict } from "./conflicts";

import type { TimetableSlot } from "./queries";

function makeSlot(overrides: Partial<TimetableSlot> & Pick<TimetableSlot, "id">): TimetableSlot {
  return {
    school_id: "school-1",
    timetable_version_id: "version-1",
    class_id: "class-1",
    teacher_id: "teacher-1",
    room_id: "room-1",
    weekday: 1,
    period: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const classCode = (id: string) => (id === "class-1" ? "MATH-101" : `class-${id}`);
const teacherName = (id: string) => (id === "teacher-1" ? "Ms. Chen" : `teacher-${id}`);
const roomName = (id: string) => (id === "room-1" ? "RM-101" : `room-${id}`);

describe("findLocalConflict", () => {
  test("returns null when the cell is unoccupied", () => {
    const conflict = findLocalConflict(
      [],
      { teacher_id: "teacher-1", room_id: "room-1", weekday: 1, period: 1 },
      classCode,
      teacherName,
      roomName,
    );
    expect(conflict).toBeNull();
  });

  test("returns null when the same weekday/period is used by a different teacher and room", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 1, period: 1 })];
    const conflict = findLocalConflict(
      slots,
      { teacher_id: "teacher-2", room_id: "room-2", weekday: 1, period: 1 },
      classCode,
      teacherName,
      roomName,
    );
    expect(conflict).toBeNull();
  });

  test("flags a teacher already booked in the same weekday/period", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 1, period: 1, teacher_id: "teacher-1" })];
    const conflict = findLocalConflict(
      slots,
      { teacher_id: "teacher-1", room_id: "room-2", weekday: 1, period: 1 },
      classCode,
      teacherName,
      roomName,
    );
    expect(conflict?.conflictType).toBe("teacher");
    expect(conflict?.existingSlot.id).toBe("slot-1");
    expect(conflict?.message).toBe(
      'Teacher "Ms. Chen" is already scheduled for class "MATH-101" on Monday, period 1.',
    );
  });

  test("flags a room already booked in the same weekday/period", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 2, period: 3, room_id: "room-1" })];
    const conflict = findLocalConflict(
      slots,
      { teacher_id: "teacher-2", room_id: "room-1", weekday: 2, period: 3 },
      classCode,
      teacherName,
      roomName,
    );
    expect(conflict?.conflictType).toBe("room");
    expect(conflict?.message).toBe(
      'Room "RM-101" is already scheduled for class "MATH-101" on Tuesday, period 3.',
    );
  });

  test("prefers the teacher conflict when both teacher and room collide", () => {
    const slots = [
      makeSlot({ id: "slot-1", weekday: 1, period: 1, teacher_id: "teacher-1", room_id: "room-1" }),
    ];
    const conflict = findLocalConflict(
      slots,
      { teacher_id: "teacher-1", room_id: "room-1", weekday: 1, period: 1 },
      classCode,
      teacherName,
      roomName,
    );
    expect(conflict?.conflictType).toBe("teacher");
  });

  test("ignores a different weekday or period", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 1, period: 1, teacher_id: "teacher-1" })];
    expect(
      findLocalConflict(
        slots,
        { teacher_id: "teacher-1", room_id: "room-2", weekday: 2, period: 1 },
        classCode,
        teacherName,
        roomName,
      ),
    ).toBeNull();
    expect(
      findLocalConflict(
        slots,
        { teacher_id: "teacher-1", room_id: "room-2", weekday: 1, period: 2 },
        classCode,
        teacherName,
        roomName,
      ),
    ).toBeNull();
  });

  test("excludes the slot being edited from its own collision check", () => {
    const slots = [makeSlot({ id: "slot-1", weekday: 1, period: 1, teacher_id: "teacher-1" })];
    const conflict = findLocalConflict(
      slots,
      {
        teacher_id: "teacher-1",
        room_id: "room-2",
        weekday: 1,
        period: 1,
        excludeSlotId: "slot-1",
      },
      classCode,
      teacherName,
      roomName,
    );
    expect(conflict).toBeNull();
  });
});
