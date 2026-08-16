import { weekdayLabel } from "./constants";

import type { TimetableSlot } from "./queries";

export interface SlotCandidate {
  teacher_id: string;
  room_id: string;
  weekday: number;
  period: number;
  /** Excluded from the collision search — set when editing an existing slot in place, so it doesn't
   * collide with itself. */
  excludeSlotId?: string;
}

export interface SlotConflict {
  conflictType: "teacher" | "room";
  existingSlot: TimetableSlot;
  message: string;
}

/**
 * Client-side collision check against the slots already loaded for this version, so a conflict can
 * render the instant a drop happens rather than waiting on a round trip. This is a UX accelerant, not
 * the source of truth: the DB's `EXCLUDE` constraints (`ex_timetable_slots_teacher_weekday_period`,
 * `ex_timetable_slots_room_weekday_period`) still enforce the real invariant, and a 409 from the
 * server is handled the same way — see `apiConflictMessage` below and `TimetableGrid.tsx`'s mutation
 * handlers.
 *
 * Mirrors `findConflict`/`throwConflictError` in `apps/api/src/modules/academics/timetable-service.ts`
 * exactly: same "teacher wins over room when both collide" precedence, same message shape, so a
 * locally-caught conflict and a server-caught one read identically.
 */
export function findLocalConflict(
  slots: readonly TimetableSlot[],
  candidate: SlotCandidate,
  classCode: (classId: string) => string,
  teacherName: (teacherId: string) => string,
  roomName: (roomId: string) => string,
): SlotConflict | null {
  const existing = slots.find(
    (slot) =>
      slot.id !== candidate.excludeSlotId &&
      slot.weekday === candidate.weekday &&
      slot.period === candidate.period &&
      (slot.teacher_id === candidate.teacher_id || slot.room_id === candidate.room_id),
  );
  if (!existing) return null;

  const conflictType: SlotConflict["conflictType"] =
    existing.teacher_id === candidate.teacher_id ? "teacher" : "room";
  const label =
    conflictType === "teacher" ? teacherName(existing.teacher_id) : roomName(existing.room_id);
  const resource = conflictType === "teacher" ? "Teacher" : "Room";

  return {
    conflictType,
    existingSlot: existing,
    message:
      `${resource} "${label}" is already scheduled for class "${classCode(existing.class_id)}" ` +
      `on ${weekdayLabel(candidate.weekday)}, period ${candidate.period}.`,
  };
}
