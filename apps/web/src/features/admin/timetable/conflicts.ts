import { i18next } from "../../../lib/i18n/i18next";

import { weekdayLabel } from "./constants";

import type { TimetableSlot } from "./queries";
import type { TFunction } from "i18next";

export interface SlotCandidate {
  teacher_id: string;
  weekday: number;
  period: number;
  /** Excluded from the collision search — set when editing an existing slot in place, so it doesn't
   * collide with itself. */
  excludeSlotId?: string;
}

export interface SlotConflict {
  conflictType: "teacher";
  existingSlot: TimetableSlot;
  message: string;
}

/**
 * Client-side collision check against the slots already loaded for this version, so a conflict can
 * render the instant a drop happens rather than waiting on a round trip. This is a UX accelerant, not
 * the source of truth: the DB's `EXCLUDE` constraint (`ex_timetable_slots_teacher_weekday_period`)
 * still enforces the real invariant, and a 409 from the server is handled the same way — see `apiConflictMessage` below and `TimetableGrid.tsx`'s mutation
 * handlers.
 *
 * Mirrors `findConflict`/`throwConflictError` in `apps/api/src/modules/academics/timetable-service.ts`
 * for teacher clashes: same message shape, so a locally-caught conflict and a server-caught one read
 * identically. Lessons carry no room, so rooms never clash here.
 *
 * `t` renders the message in the active UI language; components pass their own `useTranslation()`
 * `t`, and it defaults to the app's i18next instance for non-React callers.
 */
export function findLocalConflict(
  slots: readonly TimetableSlot[],
  candidate: SlotCandidate,
  classCode: (classId: string) => string,
  teacherName: (teacherId: string) => string,
  t: TFunction = i18next.t.bind(i18next),
): SlotConflict | null {
  const existing = slots.find(
    (slot) =>
      slot.id !== candidate.excludeSlotId &&
      slot.weekday === candidate.weekday &&
      slot.period === candidate.period &&
      slot.teacher_id === candidate.teacher_id,
  );
  if (!existing) return null;

  const conflictType: SlotConflict["conflictType"] = "teacher";
  const label = teacherName(existing.teacher_id);

  return {
    conflictType,
    existingSlot: existing,
    message: t(`adminSchool.timetable.conflict.${conflictType}`, {
      label,
      classCode: classCode(existing.class_id),
      day: weekdayLabel(candidate.weekday, t),
      period: candidate.period,
    }),
  };
}

export interface SectionCandidate {
  /** The grade section of the class being placed; `null` (no section) never clashes. */
  section_id: string | null;
  weekday: number;
  period: number;
  /** As for `SlotCandidate`: the slot being edited in place. */
  excludeSlotId?: string;
}

export interface SectionClash {
  existingSlot: TimetableSlot;
  message: string;
}

/**
 * A grade section with two lessons at the same weekday/period — its students can't be in both. Unlike
 * a teacher clash this is only a warning: the database doesn't forbid it, and a school may
 * split a section into groups (two languages, say) that legitimately run side by side. Callers place
 * the lesson anyway and surface the message so a real mistake gets noticed.
 */
export function findSectionClash(
  slots: readonly TimetableSlot[],
  candidate: SectionCandidate,
  classCode: (classId: string) => string,
  t: TFunction = i18next.t.bind(i18next),
): SectionClash | null {
  if (candidate.section_id === null) return null;
  const existing = slots.find(
    (slot) =>
      slot.id !== candidate.excludeSlotId &&
      slot.section_id === candidate.section_id &&
      slot.weekday === candidate.weekday &&
      slot.period === candidate.period,
  );
  if (!existing) return null;

  return {
    existingSlot: existing,
    message: t("adminSchool.timetable.conflict.section", {
      label:
        existing.grade_level_name !== null && existing.section_name !== null
          ? t("adminSchool.timetable.sectionLabel", {
              grade: existing.grade_level_name,
              section: existing.section_name,
            })
          : t("adminSchool.timetable.unknownSection"),
      classCode: classCode(existing.class_id),
      day: weekdayLabel(candidate.weekday, t),
      period: candidate.period,
    }),
  };
}
