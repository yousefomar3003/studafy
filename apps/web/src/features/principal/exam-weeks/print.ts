import type { ExamPeriod, ExamSlot, ExamSlotSeating } from "./queries";

/**
 * What the printed sheets show, worked out from an exam period and its seating. Pure, so the
 * grouping is unit-tested on its own (print.test.ts).
 *
 * A seating list is one exam's candidates in name order, each with their room and seat, for the
 * notice board. A door sheet is one room on one day for one sitting: every exam sitting in the room
 * at overlapping times (a hall shared by two grades is one sheet), its seats in order, for the
 * room's door and its invigilators.
 */

export interface SeatingListRow {
  student_id: string;
  name: string;
  admission_number: string;
  section: string;
  room: string | null;
  seat_number: number | null;
}

export interface SeatingList {
  slot: ExamSlot;
  rows: SeatingListRow[];
}

export interface DoorSheetRow {
  seat_number: number;
  name: string;
  admission_number: string;
  section: string;
  exam: string;
}

export interface DoorSheet {
  key: string;
  room: { id: string; code: string; name: string; building: string | null };
  exam_date: string;
  starts_at: string;
  ends_at: string;
  exams: ExamSlot[];
  invigilators: string[];
  rows: DoorSheetRow[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const minutes = (time: string) => {
  const [hours, mins] = time.split(":");
  return Number(hours) * 60 + Number(mins);
};

const examLabel = (slot: ExamSlot) => `${slot.subject.name} (${slot.grade_level.name})`;

export function seatingLists(
  period: Pick<ExamPeriod, "slots">,
  seating: readonly ExamSlotSeating[],
): SeatingList[] {
  const bySlot = new Map(seating.map((entry) => [entry.slot_id, entry]));
  return period.slots.map((slot) => {
    const entry = bySlot.get(slot.id);
    const roomName = new Map(slot.rooms.map((room) => [room.id, room.name]));
    const rows: SeatingListRow[] = [
      ...(entry?.seats ?? []).map((seat) => ({
        student_id: seat.student_id,
        name: `${seat.last_name}, ${seat.first_name}`,
        admission_number: seat.admission_number,
        section: seat.section.name,
        room: roomName.get(seat.room_id) ?? null,
        seat_number: seat.seat_number,
      })),
      ...(entry?.unseated ?? []).map((student) => ({
        student_id: student.student_id,
        name: `${student.last_name}, ${student.first_name}`,
        admission_number: student.admission_number,
        section: student.section.name,
        room: null,
        seat_number: null,
      })),
    ].sort(
      (a, b) => collator.compare(a.name, b.name) || collator.compare(a.student_id, b.student_id),
    );
    return { slot, rows };
  });
}

export function doorSheets(
  period: Pick<ExamPeriod, "slots">,
  seating: readonly ExamSlotSeating[],
): DoorSheet[] {
  const bySlot = new Map(seating.map((entry) => [entry.slot_id, entry]));
  // Every (room, day) with the exams sitting in it.
  const byRoomDay = new Map<string, { room: ExamSlot["rooms"][number]; slots: ExamSlot[] }>();
  for (const slot of period.slots) {
    for (const room of slot.rooms) {
      const key = `${room.id}|${slot.exam_date}`;
      const entry = byRoomDay.get(key) ?? { room, slots: [] };
      entry.slots.push(slot);
      byRoomDay.set(key, entry);
    }
  }

  const sheets: DoorSheet[] = [];
  for (const { room, slots } of byRoomDay.values()) {
    // Exams at overlapping times share the room: one sheet per run of overlapping exams.
    const ordered = [...slots].sort(
      (a, b) =>
        minutes(a.starts_at) - minutes(b.starts_at) || minutes(a.ends_at) - minutes(b.ends_at),
    );
    const groups: ExamSlot[][] = [];
    let groupEnd = -1;
    for (const slot of ordered) {
      const last = groups.at(-1);
      if (last && minutes(slot.starts_at) < groupEnd) {
        last.push(slot);
        groupEnd = Math.max(groupEnd, minutes(slot.ends_at));
      } else {
        groups.push([slot]);
        groupEnd = minutes(slot.ends_at);
      }
    }
    for (const group of groups) {
      const rows: DoorSheetRow[] = [];
      const invigilators = new Set<string>();
      for (const slot of group) {
        for (const duty of slot.rooms.find((candidate) => candidate.id === room.id)?.invigilators ??
          []) {
          invigilators.add(duty.name);
        }
        for (const seat of bySlot.get(slot.id)?.seats ?? []) {
          if (seat.room_id !== room.id) continue;
          rows.push({
            seat_number: seat.seat_number,
            name: `${seat.last_name}, ${seat.first_name}`,
            admission_number: seat.admission_number,
            section: seat.section.name,
            exam: examLabel(slot),
          });
        }
      }
      rows.sort((a, b) => a.seat_number - b.seat_number);
      const first = group[0]!;
      sheets.push({
        key: `${room.id}|${first.exam_date}|${first.starts_at}`,
        room: { id: room.id, code: room.code, name: room.name, building: room.building },
        exam_date: first.exam_date,
        starts_at: group.map((slot) => slot.starts_at).sort()[0]!,
        ends_at: group
          .map((slot) => slot.ends_at)
          .sort()
          .at(-1)!,
        exams: group,
        invigilators: [...invigilators].sort((a, b) => collator.compare(a, b)),
        rows,
      });
    }
  }
  return sheets.sort(
    (a, b) =>
      a.exam_date.localeCompare(b.exam_date) ||
      minutes(a.starts_at) - minutes(b.starts_at) ||
      collator.compare(a.room.code, b.room.code),
  );
}

export { examLabel };
