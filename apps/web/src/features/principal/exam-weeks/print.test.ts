// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { doorSheets, seatingLists } from "./print";

import type { ExamSlot, ExamSlotSeating } from "./queries";

const hall = { id: "hall", code: "HALL", name: "Main hall", building: "A", floor: null };

function slot(id: string, overrides: Partial<ExamSlot> = {}): ExamSlot {
  return {
    id,
    period_id: "p1",
    subject: { id: `sub-${id}`, code: id.toUpperCase(), name: id },
    grade_level: { id: "g10", name: "Grade 10" },
    sections: [],
    exam_date: "2026-12-08",
    starts_at: "09:00",
    ends_at: "11:00",
    assessment: null,
    notes: null,
    rooms: [{ ...hall, capacity: 10, seated: 0, invigilators: [{ id: "t1", name: "Rana" }] }],
    candidates: 0,
    seated: 0,
    ...overrides,
  };
}

const student = (id: string, first: string, last: string) => ({
  student_id: id,
  first_name: first,
  last_name: last,
  admission_number: `A-${id}`,
  section: { id: "s", name: "10A" },
});

const seating: ExamSlotSeating[] = [
  {
    slot_id: "math",
    seats: [
      { ...student("1", "Zaid", "Omar"), room_id: "hall", seat_number: 2 },
      { ...student("2", "Amal", "Haddad"), room_id: "hall", seat_number: 1 },
    ],
    unseated: [student("3", "Badr", "Nasser")],
  },
  {
    slot_id: "physics",
    seats: [{ ...student("4", "Dina", "Saleh"), room_id: "hall", seat_number: 3 }],
    unseated: [],
  },
];

describe("seatingLists", () => {
  test("one list per exam, by name, with the unseated shown without a seat", () => {
    const [math] = seatingLists({ slots: [slot("math")] }, seating);
    expect(math!.rows.map((row) => [row.name, row.room, row.seat_number])).toEqual([
      ["Haddad, Amal", "Main hall", 1],
      ["Nasser, Badr", null, null],
      ["Omar, Zaid", "Main hall", 2],
    ]);
  });
});

describe("doorSheets", () => {
  test("exams sharing a room at overlapping times make one sheet, seats in order", () => {
    const sheets = doorSheets(
      {
        slots: [
          slot("math"),
          slot("physics", {
            starts_at: "10:00",
            ends_at: "12:00",
            rooms: [
              { ...hall, capacity: 10, seated: 0, invigilators: [{ id: "t2", name: "Ali" }] },
            ],
          }),
        ],
      },
      seating,
    );
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toMatchObject({
      room: { code: "HALL" },
      exam_date: "2026-12-08",
      starts_at: "09:00",
      ends_at: "12:00",
      invigilators: ["Ali", "Rana"],
    });
    expect(sheets[0]!.rows.map((row) => [row.seat_number, row.name, row.exam])).toEqual([
      [1, "Haddad, Amal", "math (Grade 10)"],
      [2, "Omar, Zaid", "math (Grade 10)"],
      [3, "Saleh, Dina", "physics (Grade 10)"],
    ]);
  });

  test("an exam after another in the same room, or another day, is its own sheet", () => {
    const sheets = doorSheets(
      {
        slots: [
          slot("math"),
          slot("physics", { starts_at: "11:00", ends_at: "12:00" }),
          slot("arabic", { exam_date: "2026-12-07" }),
        ],
      },
      seating,
    );
    expect(sheets.map((sheet) => [sheet.exam_date, sheet.starts_at])).toEqual([
      ["2026-12-07", "09:00"],
      ["2026-12-08", "09:00"],
      ["2026-12-08", "11:00"],
    ]);
  });
});
