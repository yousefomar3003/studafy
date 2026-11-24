/**
 * Exam seating (000266): who sits where in one exam slot. Pure -- no database, no clock -- so the
 * rules are unit-tested on their own and the service only loads and saves.
 *
 * A slot's candidates are seated into its rooms in the rooms' filling order, each room from seat 1
 * up to its exam capacity. Seat numbers another slot already uses in the same room at the same time
 * (a hall shared by two grades) are skipped, so the two slots never share a seat.
 *
 * Strategies, the order candidates take the free seats in:
 *   by_section    section by section (sections by name), each section alphabetically
 *   alphabetical  everyone alphabetically by last name, then first name, sections mixed as they fall
 *   mixed         sections interleaved one student at a time (A1, B1, C1, A2, B2...), so neighbours
 *                 come from different sections
 *
 * Seat numbers are stable: regenerating with `keepExisting` leaves every still-valid seat where it is
 * (the student still sits the exam, the room is still the slot's, the seat is inside the room's
 * capacity and not used by another slot) and only seats the rest in the free seats. Without it, the
 * whole slot is seated afresh. Every tie is broken by id, so the same input always gives the same
 * seating.
 */

export const SEATING_STRATEGIES = ["by_section", "alphabetical", "mixed"] as const;
export type SeatingStrategy = (typeof SEATING_STRATEGIES)[number];

export interface SeatingCandidate {
  student_id: string;
  section_id: string;
  section_name: string;
  first_name: string;
  last_name: string;
}

export interface SeatingRoom {
  room_id: string;
  /** Seats the room has in an exam; null when the school has not set one (the room seats nobody). */
  capacity: number | null;
  /** Seat numbers used in this room by other slots at the same time. */
  taken?: Iterable<number>;
}

export interface Seat {
  student_id: string;
  room_id: string;
  seat_number: number;
}

export interface SeatingInput {
  candidates: readonly SeatingCandidate[];
  /** The slot's rooms in filling order. */
  rooms: readonly SeatingRoom[];
  strategy: SeatingStrategy;
  /** The slot's current seats. */
  existing?: readonly Seat[];
  keepExisting?: boolean;
}

export interface SeatingResult {
  /** Every seat of the slot, by room (filling order), then seat number. */
  seats: Seat[];
  /** Candidates who did not fit, in the strategy's order. */
  unseated: string[];
  /** How many existing seats were kept as they were. */
  kept: number;
  /** Free seats across the slot's rooms before seating (capacity minus other slots' seats). */
  capacity: number;
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function compareText(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function compareByName(a: SeatingCandidate, b: SeatingCandidate): number {
  return (
    compareText(a.last_name, b.last_name) ||
    compareText(a.first_name, b.first_name) ||
    compareText(a.student_id, b.student_id)
  );
}

function compareSections(a: SeatingCandidate, b: SeatingCandidate): number {
  return compareText(a.section_name, b.section_name) || compareText(a.section_id, b.section_id);
}

/** Candidates in the order a strategy seats them. */
export function orderCandidates(
  candidates: readonly SeatingCandidate[],
  strategy: SeatingStrategy,
): SeatingCandidate[] {
  if (strategy === "alphabetical") return [...candidates].sort(compareByName);
  const bySection = [...candidates].sort((a, b) => compareSections(a, b) || compareByName(a, b));
  if (strategy === "by_section") return bySection;

  // mixed: one student from each section in turn.
  const groups: SeatingCandidate[][] = [];
  for (const candidate of bySection) {
    const last = groups.at(-1);
    if (last && last[0]!.section_id === candidate.section_id) last.push(candidate);
    else groups.push([candidate]);
  }
  const out: SeatingCandidate[] = [];
  for (let index = 0; out.length < bySection.length; index += 1) {
    for (const group of groups) {
      const candidate = group[index];
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

function roomCapacity(room: SeatingRoom): number {
  return room.capacity !== null && room.capacity > 0 ? Math.floor(room.capacity) : 0;
}

/** Free seats across rooms: each room's capacity minus the seats other slots use in it. */
export function freeCapacity(rooms: readonly SeatingRoom[]): number {
  let total = 0;
  for (const room of rooms) {
    const capacity = roomCapacity(room);
    const taken = new Set([...(room.taken ?? [])].filter((seat) => seat >= 1 && seat <= capacity));
    total += capacity - taken.size;
  }
  return total;
}

/** Seat a slot's candidates. */
export function generateSeating(input: SeatingInput): SeatingResult {
  const ordered = orderCandidates(input.candidates, input.strategy);
  const candidateIds = new Set(ordered.map((candidate) => candidate.student_id));
  const roomOrder = new Map(input.rooms.map((room, index) => [room.room_id, index]));
  const used = new Map<string, Set<number>>();
  for (const room of input.rooms) {
    used.set(room.room_id, new Set(room.taken ?? []));
  }

  const seats: Seat[] = [];
  const seated = new Set<string>();
  if (input.keepExisting) {
    const existing = [...(input.existing ?? [])].sort(
      (a, b) =>
        (roomOrder.get(a.room_id) ?? 0) - (roomOrder.get(b.room_id) ?? 0) ||
        a.seat_number - b.seat_number ||
        compareText(a.student_id, b.student_id),
    );
    for (const seat of existing) {
      const room = input.rooms[roomOrder.get(seat.room_id) ?? -1];
      const taken = used.get(seat.room_id);
      if (
        !room ||
        !taken ||
        !candidateIds.has(seat.student_id) ||
        seated.has(seat.student_id) ||
        !Number.isInteger(seat.seat_number) ||
        seat.seat_number < 1 ||
        seat.seat_number > roomCapacity(room) ||
        taken.has(seat.seat_number)
      ) {
        continue;
      }
      taken.add(seat.seat_number);
      seated.add(seat.student_id);
      seats.push({ ...seat });
    }
  }
  const kept = seats.length;
  const capacity = freeCapacity(input.rooms);

  const unseated: string[] = [];
  let roomIndex = 0;
  let nextSeat = 1;
  for (const candidate of ordered) {
    if (seated.has(candidate.student_id)) continue;
    let placed = false;
    while (roomIndex < input.rooms.length) {
      const room = input.rooms[roomIndex]!;
      const taken = used.get(room.room_id)!;
      const limit = roomCapacity(room);
      while (nextSeat <= limit && taken.has(nextSeat)) nextSeat += 1;
      if (nextSeat <= limit) {
        taken.add(nextSeat);
        seats.push({
          student_id: candidate.student_id,
          room_id: room.room_id,
          seat_number: nextSeat,
        });
        seated.add(candidate.student_id);
        placed = true;
        break;
      }
      roomIndex += 1;
      nextSeat = 1;
    }
    if (!placed) unseated.push(candidate.student_id);
  }

  seats.sort(
    (a, b) =>
      (roomOrder.get(a.room_id) ?? 0) - (roomOrder.get(b.room_id) ?? 0) ||
      a.seat_number - b.seat_number,
  );
  return { seats, unseated, kept, capacity };
}

export type SeatMovePlan =
  | { kind: "move" }
  | { kind: "swap"; with_student_id: string; from: Seat }
  | {
      kind: "rejected";
      reason: "NOT_SEATED_HERE" | "ROOM_NOT_IN_SLOT" | "SEAT_OUT_OF_RANGE" | "SEAT_TAKEN";
    };

/**
 * A manual change to one student's seat: to a free seat, or a swap with the student of this slot
 * who sits there. A seat another slot uses in the room at the same time cannot be taken.
 */
export function planSeatMove(input: {
  student_id: string;
  room_id: string;
  seat_number: number;
  rooms: readonly SeatingRoom[];
  seats: readonly Seat[];
}): SeatMovePlan {
  const current = input.seats.find((seat) => seat.student_id === input.student_id);
  if (!current) return { kind: "rejected", reason: "NOT_SEATED_HERE" };
  const room = input.rooms.find((candidate) => candidate.room_id === input.room_id);
  if (!room) return { kind: "rejected", reason: "ROOM_NOT_IN_SLOT" };
  if (
    !Number.isInteger(input.seat_number) ||
    input.seat_number < 1 ||
    input.seat_number > roomCapacity(room)
  ) {
    return { kind: "rejected", reason: "SEAT_OUT_OF_RANGE" };
  }
  if (new Set(room.taken ?? []).has(input.seat_number)) {
    return { kind: "rejected", reason: "SEAT_TAKEN" };
  }
  const holder = input.seats.find(
    (seat) => seat.room_id === input.room_id && seat.seat_number === input.seat_number,
  );
  if (!holder || holder.student_id === input.student_id) return { kind: "move" };
  return { kind: "swap", with_student_id: holder.student_id, from: { ...current } };
}
