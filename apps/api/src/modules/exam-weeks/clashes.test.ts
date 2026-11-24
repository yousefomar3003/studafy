// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { detectExamClashes, minutesOf, overlaps } from "./clashes";

import type { ClashSlot } from "./clashes";

function slot(id: string, overrides: Partial<ClashSlot> = {}): ClashSlot {
  return {
    slot_id: id,
    exam_date: "2027-01-10",
    starts_at: "09:00",
    ends_at: "11:00",
    student_ids: [],
    rooms: [],
    seats: [],
    invigilators: [],
    ...overrides,
  };
}

const seated = (roomId: string, students: string[], from = 1) =>
  students.map((student_id, index) => ({ student_id, room_id: roomId, seat_number: from + index }));

describe("time overlap", () => {
  test("minutes of a time, with or without seconds", () => {
    expect(minutesOf("09:30")).toBe(570);
    expect(minutesOf("09:30:00")).toBe(570);
  });

  test("same day and overlapping times; touching ends do not overlap", () => {
    expect(overlaps(slot("a"), slot("b", { starts_at: "10:30", ends_at: "12:00" }))).toBe(true);
    expect(overlaps(slot("a"), slot("b", { starts_at: "11:00", ends_at: "12:00" }))).toBe(false);
    expect(overlaps(slot("a"), slot("b", { exam_date: "2027-01-11" }))).toBe(false);
    expect(overlaps(slot("a"), slot("b", { starts_at: "08:00:00", ends_at: "13:00:00" }))).toBe(
      true,
    );
  });
});

describe("detectExamClashes", () => {
  test("a clean timetable has no clashes", () => {
    const clashes = detectExamClashes([
      slot("math", {
        student_ids: ["s1", "s2"],
        rooms: [{ room_id: "hall", capacity: 2 }],
        seats: seated("hall", ["s1", "s2"]),
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
      }),
      slot("science", {
        starts_at: "11:00",
        ends_at: "12:00",
        student_ids: ["s1", "s2"],
        rooms: [{ room_id: "hall", capacity: 2 }],
        seats: seated("hall", ["s1", "s2"]),
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
      }),
    ]);
    expect(clashes).toEqual([]);
  });

  test("a teacher in two rooms at once", () => {
    const clashes = detectExamClashes([
      slot("math", {
        rooms: [{ room_id: "r1", capacity: 10 }],
        invigilators: [{ teacher_id: "t1", room_id: "r1" }],
      }),
      slot("arabic", {
        starts_at: "10:00",
        ends_at: "12:00",
        rooms: [{ room_id: "r2", capacity: 10 }],
        invigilators: [{ teacher_id: "t1", room_id: "r2" }],
      }),
    ]);
    expect(clashes).toEqual([
      {
        type: "teacher_double_booked",
        severity: "error",
        teacher_id: "t1",
        slot_ids: ["arabic", "math"],
        room_ids: ["r1", "r2"],
      },
    ]);
  });

  test("a teacher watching one shared room for two exams is not a clash", () => {
    const clashes = detectExamClashes([
      slot("g10", {
        rooms: [{ room_id: "hall", capacity: 50 }],
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
      }),
      slot("g11", {
        rooms: [{ room_id: "hall", capacity: 50 }],
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
      }),
    ]);
    expect(clashes).toEqual([]);
  });

  test("a teacher in two rooms of the same exam", () => {
    const clashes = detectExamClashes([
      slot("math", {
        rooms: [
          { room_id: "r1", capacity: 10 },
          { room_id: "r2", capacity: 10 },
        ],
        invigilators: [
          { teacher_id: "t1", room_id: "r1" },
          { teacher_id: "t1", room_id: "r2" },
        ],
      }),
    ]);
    expect(clashes).toMatchObject([
      { type: "teacher_double_booked", slot_ids: ["math"], room_ids: ["r1", "r2"] },
    ]);
  });

  test("students with two exams at once, one entry per pair of exams", () => {
    const clashes = detectExamClashes([
      slot("math", { student_ids: ["s1", "s2", "s3"] }),
      slot("physics", { starts_at: "10:00", ends_at: "11:30", student_ids: ["s3", "s2", "s9"] }),
      slot("later", { starts_at: "11:30", ends_at: "12:30", student_ids: ["s1", "s2", "s3"] }),
    ]);
    expect(clashes.filter((clash) => clash.severity === "error")).toEqual([
      {
        type: "student_double_booked",
        severity: "error",
        slot_ids: ["math", "physics"],
        student_ids: ["s2", "s3"],
      },
    ]);
  });

  test("a room over capacity at its busiest moment, across slots sharing it", () => {
    const clashes = detectExamClashes([
      slot("g10", {
        student_ids: ["a", "b"],
        rooms: [{ room_id: "hall", capacity: 3 }],
        seats: seated("hall", ["a", "b"]),
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
      }),
      slot("g11", {
        starts_at: "10:00",
        ends_at: "12:00",
        student_ids: ["c", "d"],
        rooms: [{ room_id: "hall", capacity: 3 }],
        seats: seated("hall", ["c", "d"], 3),
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
      }),
      // Starts when g10 ends: only g11's two are in the room with it.
      slot("g12", {
        starts_at: "11:00",
        ends_at: "12:00",
        student_ids: ["e"],
        rooms: [{ room_id: "hall", capacity: 3 }],
        seats: seated("hall", ["e"], 9),
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
      }),
    ]);
    expect(clashes).toEqual([
      {
        type: "room_over_capacity",
        severity: "error",
        room_id: "hall",
        slot_ids: ["g10", "g11"],
        seated: 4,
        capacity: 3,
      },
    ]);
  });

  test("the same seat used by two slots sharing a room", () => {
    const clashes = detectExamClashes([
      slot("g10", {
        rooms: [{ room_id: "hall", capacity: 10 }],
        seats: seated("hall", ["a"], 4),
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
        student_ids: ["a"],
      }),
      slot("g11", {
        rooms: [{ room_id: "hall", capacity: 10 }],
        seats: seated("hall", ["b"], 4),
        invigilators: [{ teacher_id: "t1", room_id: "hall" }],
        student_ids: ["b"],
      }),
    ]);
    expect(clashes).toEqual([
      {
        type: "seat_double_booked",
        severity: "error",
        room_id: "hall",
        seat_number: 4,
        slot_ids: ["g10", "g11"],
      },
    ]);
  });

  test("warnings: no capacity, too few seats, unseated, unwatched room, holiday", () => {
    const clashes = detectExamClashes(
      [
        slot("math", {
          exam_date: "2027-01-12",
          student_ids: ["a", "b", "c"],
          rooms: [
            { room_id: "r1", capacity: 2 },
            { room_id: "lab", capacity: null },
          ],
          seats: seated("r1", ["a", "b"]),
        }),
      ],
      [{ title: "Founders' day", starts_on: "2027-01-12", ends_on: "2027-01-12" }],
    );
    expect(clashes).toEqual([
      { type: "room_without_capacity", severity: "warning", room_id: "lab", slot_ids: ["math"] },
      {
        type: "insufficient_capacity",
        severity: "warning",
        slot_ids: ["math"],
        candidates: 3,
        capacity: 2,
      },
      { type: "unseated_students", severity: "warning", slot_ids: ["math"], count: 1 },
      { type: "no_invigilator", severity: "warning", room_id: "r1", slot_ids: ["math"] },
      { type: "on_holiday", severity: "warning", slot_ids: ["math"], holiday: "Founders' day" },
    ]);
  });

  test("errors come before warnings", () => {
    const clashes = detectExamClashes([
      slot("a", { student_ids: ["s1"] }),
      slot("b", { student_ids: ["s1"] }),
    ]);
    expect(clashes.map((clash) => clash.severity)).toEqual(["error", "warning", "warning"]);
  });
});
