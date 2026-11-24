/**
 * Exam timetable clashes (000266), worked out on read from a period's slots. Pure, like seating.ts.
 *
 * Two slots are "at the same time" when they are on the same date and their times overlap (an exam
 * ending at 11:00 does not overlap one starting at 11:00). Errors:
 *   teacher_double_booked   a teacher invigilates two different rooms at the same time
 *   student_double_booked   students who sit two exams at the same time (one entry per pair)
 *   room_over_capacity      more students seated in a room at one moment than it holds
 *   seat_double_booked      two slots sharing a room use the same seat number at the same time
 * Warnings:
 *   room_without_capacity   a slot's room has no exam or everyday capacity, so nobody can be seated
 *   insufficient_capacity   a slot's rooms cannot seat all its candidates
 *   unseated_students       candidates of a slot without a seat
 *   no_invigilator          a room of a slot with students seated and nobody invigilating it
 *   on_holiday              a slot on a day of a school holiday
 */

export interface ClashSlot {
  slot_id: string;
  /** YYYY-MM-DD, the school's calendar day. */
  exam_date: string;
  /** HH:MM or HH:MM:SS, the school's wall clock. */
  starts_at: string;
  ends_at: string;
  /** Who sits the exam. */
  student_ids: readonly string[];
  rooms: readonly { room_id: string; capacity: number | null }[];
  seats: readonly { student_id: string; room_id: string; seat_number: number }[];
  invigilators: readonly { teacher_id: string; room_id: string }[];
}

export interface ClashHoliday {
  title: string;
  starts_on: string;
  ends_on: string;
}

export type ExamClash =
  | {
      type: "teacher_double_booked";
      severity: "error";
      teacher_id: string;
      slot_ids: string[];
      room_ids: string[];
    }
  | {
      type: "student_double_booked";
      severity: "error";
      slot_ids: string[];
      /** Everyone who sits both exams, by id. */
      student_ids: string[];
    }
  | {
      type: "room_over_capacity";
      severity: "error";
      room_id: string;
      slot_ids: string[];
      seated: number;
      capacity: number;
    }
  | {
      type: "seat_double_booked";
      severity: "error";
      room_id: string;
      seat_number: number;
      slot_ids: string[];
    }
  | { type: "room_without_capacity"; severity: "warning"; room_id: string; slot_ids: string[] }
  | {
      type: "insufficient_capacity";
      severity: "warning";
      slot_ids: string[];
      candidates: number;
      capacity: number;
    }
  | { type: "unseated_students"; severity: "warning"; slot_ids: string[]; count: number }
  | { type: "no_invigilator"; severity: "warning"; room_id: string; slot_ids: string[] }
  | { type: "on_holiday"; severity: "warning"; slot_ids: string[]; holiday: string };

/** Minutes since midnight of an HH:MM[:SS] time. */
export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Whether two slots are at the same time: same day, overlapping times (touching ends do not). */
export function overlaps(
  a: Pick<ClashSlot, "exam_date" | "starts_at" | "ends_at">,
  b: Pick<ClashSlot, "exam_date" | "starts_at" | "ends_at">,
): boolean {
  return (
    a.exam_date === b.exam_date &&
    minutesOf(a.starts_at) < minutesOf(b.ends_at) &&
    minutesOf(b.starts_at) < minutesOf(a.ends_at)
  );
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sortedPair(a: string, b: string): string[] {
  return [a, b].sort(byText);
}

/** The peak number of students seated in one room at once, and the slots seated at that peak. */
function roomPeak(roomSlots: readonly { slot: ClashSlot; seated: number }[]): {
  seated: number;
  slot_ids: string[];
} {
  let best = { seated: 0, slot_ids: [] as string[] };
  for (const { slot } of roomSlots) {
    // The occupancy peaks at some slot's start: count everyone seated then.
    const at = minutesOf(slot.starts_at);
    const active = roomSlots.filter(
      (other) =>
        other.slot.exam_date === slot.exam_date &&
        minutesOf(other.slot.starts_at) <= at &&
        at < minutesOf(other.slot.ends_at),
    );
    const seated = active.reduce((sum, other) => sum + other.seated, 0);
    if (seated > best.seated) {
      best = { seated, slot_ids: active.map((other) => other.slot.slot_id).sort(byText) };
    }
  }
  return best;
}

/** Every clash in a period's timetable, errors first, each kind in a stable order. */
export function detectExamClashes(
  slots: readonly ClashSlot[],
  holidays: readonly ClashHoliday[] = [],
): ExamClash[] {
  const clashes: ExamClash[] = [];
  const ordered = [...slots].sort(
    (a, b) =>
      byText(a.exam_date, b.exam_date) ||
      minutesOf(a.starts_at) - minutesOf(b.starts_at) ||
      byText(a.slot_id, b.slot_id),
  );

  // Pairs of slots at the same time.
  const studentClashes = new Map<string, ExamClash>();
  const teacherClashes = new Map<string, ExamClash>();
  const seatClashes = new Map<string, ExamClash>();
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i]!;
    // Several rooms of one slot: a teacher in two of them is in two places at once.
    const ownRooms = new Map<string, string>();
    for (const duty of a.invigilators) {
      const first = ownRooms.get(duty.teacher_id);
      if (first !== undefined && first !== duty.room_id) {
        const key = `${duty.teacher_id}|${a.slot_id}|${a.slot_id}`;
        teacherClashes.set(key, {
          type: "teacher_double_booked",
          severity: "error",
          teacher_id: duty.teacher_id,
          slot_ids: [a.slot_id],
          room_ids: sortedPair(first, duty.room_id),
        });
      } else {
        ownRooms.set(duty.teacher_id, duty.room_id);
      }
    }
    for (let j = i + 1; j < ordered.length; j += 1) {
      const b = ordered[j]!;
      if (b.exam_date !== a.exam_date) break;
      if (!overlaps(a, b)) continue;
      const slotIds = sortedPair(a.slot_id, b.slot_id);

      const aStudents = new Set([...a.student_ids, ...a.seats.map((seat) => seat.student_id)]);
      const both = [...new Set([...b.student_ids, ...b.seats.map((seat) => seat.student_id)])]
        .filter((studentId) => aStudents.has(studentId))
        .sort(byText);
      if (both.length > 0) {
        studentClashes.set(slotIds.join("|"), {
          type: "student_double_booked",
          severity: "error",
          slot_ids: slotIds,
          student_ids: both,
        });
      }

      for (const dutyA of a.invigilators) {
        for (const dutyB of b.invigilators) {
          if (dutyA.teacher_id !== dutyB.teacher_id || dutyA.room_id === dutyB.room_id) continue;
          teacherClashes.set(`${dutyA.teacher_id}|${slotIds.join("|")}`, {
            type: "teacher_double_booked",
            severity: "error",
            teacher_id: dutyA.teacher_id,
            slot_ids: slotIds,
            room_ids: sortedPair(dutyA.room_id, dutyB.room_id),
          });
        }
      }

      const aSeats = new Set(a.seats.map((seat) => `${seat.room_id}|${seat.seat_number}`));
      for (const seat of b.seats) {
        if (!aSeats.has(`${seat.room_id}|${seat.seat_number}`)) continue;
        seatClashes.set(`${seat.room_id}|${seat.seat_number}|${slotIds.join("|")}`, {
          type: "seat_double_booked",
          severity: "error",
          room_id: seat.room_id,
          seat_number: seat.seat_number,
          slot_ids: slotIds,
        });
      }
    }
  }

  // Rooms over capacity at their busiest moment.
  const byRoom = new Map<
    string,
    { capacity: number | null; slots: { slot: ClashSlot; seated: number }[] }
  >();
  for (const slot of ordered) {
    for (const room of slot.rooms) {
      const entry = byRoom.get(room.room_id) ?? { capacity: room.capacity, slots: [] };
      entry.slots.push({
        slot,
        seated: slot.seats.filter((seat) => seat.room_id === room.room_id).length,
      });
      byRoom.set(room.room_id, entry);
    }
  }
  const overCapacity: ExamClash[] = [];
  const withoutCapacity: ExamClash[] = [];
  for (const [roomId, entry] of [...byRoom].sort(([a], [b]) => byText(a, b))) {
    if (entry.capacity === null || entry.capacity <= 0) {
      withoutCapacity.push({
        type: "room_without_capacity",
        severity: "warning",
        room_id: roomId,
        slot_ids: entry.slots.map(({ slot }) => slot.slot_id),
      });
      continue;
    }
    const byDate = new Map<string, { slot: ClashSlot; seated: number }[]>();
    for (const item of entry.slots) {
      byDate.set(item.slot.exam_date, [...(byDate.get(item.slot.exam_date) ?? []), item]);
    }
    for (const daySlots of byDate.values()) {
      const peak = roomPeak(daySlots);
      if (peak.seated > entry.capacity) {
        overCapacity.push({
          type: "room_over_capacity",
          severity: "error",
          room_id: roomId,
          slot_ids: peak.slot_ids,
          seated: peak.seated,
          capacity: entry.capacity,
        });
      }
    }
  }

  // Per slot: capacity, unseated candidates, rooms nobody invigilates, holidays.
  const slotWarnings: ExamClash[] = [];
  for (const slot of ordered) {
    const candidates = new Set(slot.student_ids);
    const capacity = slot.rooms.reduce((sum, room) => sum + Math.max(room.capacity ?? 0, 0), 0);
    if (slot.rooms.length > 0 && candidates.size > capacity) {
      slotWarnings.push({
        type: "insufficient_capacity",
        severity: "warning",
        slot_ids: [slot.slot_id],
        candidates: candidates.size,
        capacity,
      });
    }
    const seated = new Set(slot.seats.map((seat) => seat.student_id));
    const unseated = [...candidates].filter((studentId) => !seated.has(studentId)).length;
    if (unseated > 0) {
      slotWarnings.push({
        type: "unseated_students",
        severity: "warning",
        slot_ids: [slot.slot_id],
        count: unseated,
      });
    }
    const watched = new Set(slot.invigilators.map((duty) => duty.room_id));
    for (const room of slot.rooms) {
      if (watched.has(room.room_id)) continue;
      if (!slot.seats.some((seat) => seat.room_id === room.room_id)) continue;
      slotWarnings.push({
        type: "no_invigilator",
        severity: "warning",
        room_id: room.room_id,
        slot_ids: [slot.slot_id],
      });
    }
    const holiday = holidays.find(
      (day) => day.starts_on <= slot.exam_date && slot.exam_date <= day.ends_on,
    );
    if (holiday) {
      slotWarnings.push({
        type: "on_holiday",
        severity: "warning",
        slot_ids: [slot.slot_id],
        holiday: holiday.title,
      });
    }
  }

  clashes.push(
    ...teacherClashes.values(),
    ...studentClashes.values(),
    ...overCapacity,
    ...seatClashes.values(),
    ...withoutCapacity,
    ...slotWarnings,
  );
  return clashes;
}
