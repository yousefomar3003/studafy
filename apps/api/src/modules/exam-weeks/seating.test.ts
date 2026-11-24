// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { freeCapacity, generateSeating, orderCandidates, planSeatMove } from "./seating";

import type { SeatingCandidate } from "./seating";

const student = (
  id: string,
  section: "A" | "B" | "C",
  last: string,
  first = "X",
): SeatingCandidate => ({
  student_id: id,
  section_id: `sec-${section}`,
  section_name: `10${section}`,
  first_name: first,
  last_name: last,
});

// Section A: Zaid, Adam, Maha; section B: Badr, Nour; section C: Huda.
const candidates = [
  student("a1", "A", "Zaid"),
  student("a2", "A", "Adam"),
  student("a3", "A", "Maha"),
  student("b1", "B", "Badr"),
  student("b2", "B", "Nour"),
  student("c1", "C", "Huda"),
];

const ids = (list: readonly SeatingCandidate[]) => list.map((candidate) => candidate.student_id);

describe("orderCandidates", () => {
  test("alphabetical mixes sections by last name, then first name, then id", () => {
    expect(ids(orderCandidates(candidates, "alphabetical"))).toEqual([
      "a2", // Adam
      "b1", // Badr
      "c1", // Huda
      "a3", // Maha
      "b2", // Nour
      "a1", // Zaid
    ]);
    const twins = [student("t2", "A", "Saleh", "Ali"), student("t1", "A", "Saleh", "Ali")];
    expect(ids(orderCandidates(twins, "alphabetical"))).toEqual(["t1", "t2"]);
  });

  test("by section keeps each section together, alphabetical inside it", () => {
    expect(ids(orderCandidates(candidates, "by_section"))).toEqual([
      "a2",
      "a3",
      "a1",
      "b1",
      "b2",
      "c1",
    ]);
  });

  test("mixed takes one student from each section in turn", () => {
    expect(ids(orderCandidates(candidates, "mixed"))).toEqual(["a2", "b1", "c1", "a3", "b2", "a1"]);
  });

  test("sections sort by name with numbers in order (10B before 10C, 9 before 10)", () => {
    const list = [
      { ...student("x", "A", "One"), section_id: "s10", section_name: "10" },
      { ...student("y", "A", "Two"), section_id: "s9", section_name: "9" },
    ];
    expect(ids(orderCandidates(list, "by_section"))).toEqual(["y", "x"]);
  });

  test("Arabic names sort too, and the order never depends on the input order", () => {
    const list = [
      student("s1", "A", "يوسف"),
      student("s2", "A", "أحمد"),
      student("s3", "A", "بدر"),
    ];
    const first = ids(orderCandidates(list, "alphabetical"));
    expect(ids(orderCandidates([...list].reverse(), "alphabetical"))).toEqual(first);
    expect(first[2]).toBe("s1");
  });
});

describe("generateSeating", () => {
  const rooms = [
    { room_id: "hall", capacity: 4 },
    { room_id: "r1", capacity: 3 },
  ];

  test("fills rooms in order from seat 1", () => {
    const result = generateSeating({ candidates, rooms, strategy: "by_section" });
    expect(result.seats).toEqual([
      { student_id: "a2", room_id: "hall", seat_number: 1 },
      { student_id: "a3", room_id: "hall", seat_number: 2 },
      { student_id: "a1", room_id: "hall", seat_number: 3 },
      { student_id: "b1", room_id: "hall", seat_number: 4 },
      { student_id: "b2", room_id: "r1", seat_number: 1 },
      { student_id: "c1", room_id: "r1", seat_number: 2 },
    ]);
    expect(result.unseated).toEqual([]);
    expect(result.capacity).toBe(7);
    expect(result.kept).toBe(0);
  });

  test("candidates beyond capacity are left unseated, in order", () => {
    const result = generateSeating({
      candidates,
      rooms: [{ room_id: "small", capacity: 4 }],
      strategy: "alphabetical",
    });
    expect(result.seats.map((seat) => seat.student_id)).toEqual(["a2", "b1", "c1", "a3"]);
    expect(result.unseated).toEqual(["b2", "a1"]);
  });

  test("a room without a capacity seats nobody", () => {
    const result = generateSeating({
      candidates,
      rooms: [
        { room_id: "unknown", capacity: null },
        { room_id: "r1", capacity: 2 },
      ],
      strategy: "alphabetical",
    });
    expect(result.seats.every((seat) => seat.room_id === "r1")).toBe(true);
    expect(result.unseated).toHaveLength(4);
    expect(freeCapacity([{ room_id: "unknown", capacity: null }])).toBe(0);
  });

  test("seats another slot uses in a shared room at the same time are skipped", () => {
    const result = generateSeating({
      candidates: candidates.slice(0, 3),
      rooms: [{ room_id: "hall", capacity: 5, taken: [1, 3] }],
      strategy: "by_section",
    });
    expect(result.seats.map((seat) => seat.seat_number)).toEqual([2, 4, 5]);
    expect(result.capacity).toBe(3);
    // A taken seat outside the room's capacity takes nothing away.
    expect(freeCapacity([{ room_id: "hall", capacity: 2, taken: [1, 9] }])).toBe(1);
  });

  test("regenerating keeps every still-valid seat and seats newcomers in the free seats", () => {
    const existing = [
      { student_id: "a1", room_id: "hall", seat_number: 3 },
      { student_id: "b2", room_id: "r1", seat_number: 1 },
      // No longer sits the exam:
      { student_id: "gone", room_id: "hall", seat_number: 1 },
      // The room was taken off the slot:
      { student_id: "a2", room_id: "old-room", seat_number: 1 },
      // Beyond the room's capacity now:
      { student_id: "c1", room_id: "r1", seat_number: 9 },
    ];
    const result = generateSeating({
      candidates,
      rooms,
      strategy: "by_section",
      existing,
      keepExisting: true,
    });
    expect(result.kept).toBe(2);
    expect(result.seats).toEqual([
      { student_id: "a2", room_id: "hall", seat_number: 1 },
      { student_id: "a3", room_id: "hall", seat_number: 2 },
      { student_id: "a1", room_id: "hall", seat_number: 3 },
      { student_id: "b1", room_id: "hall", seat_number: 4 },
      { student_id: "b2", room_id: "r1", seat_number: 1 },
      { student_id: "c1", room_id: "r1", seat_number: 2 },
    ]);
  });

  test("a kept seat another slot now uses is given up", () => {
    const result = generateSeating({
      candidates: [candidates[0]!],
      rooms: [{ room_id: "hall", capacity: 3, taken: [2] }],
      strategy: "alphabetical",
      existing: [{ student_id: "a1", room_id: "hall", seat_number: 2 }],
      keepExisting: true,
    });
    expect(result.kept).toBe(0);
    expect(result.seats).toEqual([{ student_id: "a1", room_id: "hall", seat_number: 1 }]);
  });

  test("without keepExisting the slot is seated afresh", () => {
    const result = generateSeating({
      candidates,
      rooms,
      strategy: "mixed",
      existing: [{ student_id: "a1", room_id: "r1", seat_number: 3 }],
    });
    expect(result.kept).toBe(0);
    expect(result.seats.slice(0, 3).map((seat) => seat.student_id)).toEqual(["a2", "b1", "c1"]);
  });

  test("the same input always gives the same seating", () => {
    const one = generateSeating({ candidates, rooms, strategy: "mixed" });
    const two = generateSeating({
      candidates: [...candidates].reverse(),
      rooms,
      strategy: "mixed",
    });
    expect(two).toEqual(one);
  });
});

describe("planSeatMove", () => {
  const rooms = [
    { room_id: "hall", capacity: 3, taken: [3] },
    { room_id: "r1", capacity: 2 },
  ];
  const seats = [
    { student_id: "a1", room_id: "hall", seat_number: 1 },
    { student_id: "a2", room_id: "hall", seat_number: 2 },
  ];

  test("to a free seat is a move", () => {
    expect(planSeatMove({ student_id: "a1", room_id: "r1", seat_number: 2, rooms, seats })).toEqual(
      { kind: "move" },
    );
  });

  test("to a seat of this slot is a swap", () => {
    expect(
      planSeatMove({ student_id: "a1", room_id: "hall", seat_number: 2, rooms, seats }),
    ).toEqual({
      kind: "swap",
      with_student_id: "a2",
      from: { student_id: "a1", room_id: "hall", seat_number: 1 },
    });
  });

  test("rejections", () => {
    const plan = (student_id: string, room_id: string, seat_number: number) =>
      planSeatMove({ student_id, room_id, seat_number, rooms, seats });
    expect(plan("nobody", "hall", 1)).toEqual({ kind: "rejected", reason: "NOT_SEATED_HERE" });
    expect(plan("a1", "lab", 1)).toEqual({ kind: "rejected", reason: "ROOM_NOT_IN_SLOT" });
    expect(plan("a1", "r1", 3)).toEqual({ kind: "rejected", reason: "SEAT_OUT_OF_RANGE" });
    expect(plan("a1", "r1", 0)).toEqual({ kind: "rejected", reason: "SEAT_OUT_OF_RANGE" });
    expect(plan("a1", "hall", 3)).toEqual({ kind: "rejected", reason: "SEAT_TAKEN" });
  });
});
