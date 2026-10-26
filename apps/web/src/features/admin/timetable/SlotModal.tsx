import { ApiError } from "@studafy/api-client";
import { Button, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { findLocalConflict, findSectionClash } from "./conflicts";
import { weekdayLabel } from "./constants";
import { useCreateSlot, useDeleteSlot, useUpdateSlot } from "./mutations";

import type { Class, TeacherContact, TimetableSlot } from "./queries";
import type { SelectOption } from "@studafy/ui";

/** What the modal is acting on: an existing lesson, or an empty cell to add one to — optionally with
 * a class already chosen (the only class the current section filter offers). */
export type SlotModalTarget =
  | { kind: "edit"; slot: TimetableSlot }
  | { kind: "add"; weekday: number; period: number; klass?: Class };

export interface SlotModalProps {
  target: SlotModalTarget | null;
  versionId: string;
  onClose: () => void;
  /** Classes the picker offers — the section filter's classes when one is set. */
  classes: readonly Class[];
  teachers: readonly TeacherContact[];
  allSlots: readonly TimetableSlot[];
  /** Weekdays offered in the day picker, in display order. */
  days: readonly number[];
  periodCount: number;
  classCode: (classId: string) => string;
  onConflict: (message: string, existingSlotId?: string) => void;
  /** A saved lesson double-books its grade section (see `findSectionClash`). */
  onSectionClash: (message: string, existingSlotId: string) => void;
}

/**
 * Adds a lesson to a cell, or edits one in place — class, teacher, and day/period, so moving a
 * lesson is a single save rather than remove-and-replace. Every save runs the same local clash check
 * as drag-and-drop before it reaches the server, whose `EXCLUDE` constraint remains the backstop.
 */
export function SlotModal({
  target,
  versionId,
  onClose,
  classes,
  teachers,
  allSlots,
  days,
  periodCount,
  classCode,
  onConflict,
  onSectionClash,
}: SlotModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createSlot = useCreateSlot();
  const updateSlot = useUpdateSlot();
  const deleteSlot = useDeleteSlot();

  const [classId, setClassId] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [weekday, setWeekday] = useState("");
  const [period, setPeriod] = useState("");

  useEffect(() => {
    if (!target) return;
    if (target.kind === "edit") {
      setClassId(target.slot.class_id);
      setTeacherId(target.slot.teacher_id);
      setWeekday(String(target.slot.weekday));
      setPeriod(String(target.slot.period));
    } else {
      setClassId(target.klass?.id ?? "");
      setTeacherId(target.klass?.lead_teacher_id ?? "");
      setWeekday(String(target.weekday));
      setPeriod(String(target.period));
    }
  }, [target]);

  if (!target) {
    return null;
  }

  const editing = target.kind === "edit" ? target.slot : null;

  /** Picking a class pre-fills its usual teacher; it stays editable. */
  function handleClassChange(nextClassId: string) {
    setClassId(nextClassId);
    const klass = classes.find((candidate) => candidate.id === nextClassId);
    if (klass) {
      setTeacherId(klass.lead_teacher_id);
    }
  }

  // A lesson's current class stays selectable even if it has since left the schedulable list —
  // dropping it here would silently blank the field.
  const classOptions: SelectOption<string>[] = classes.map((klass) => ({
    value: klass.id,
    label: klass.code,
  }));
  if (editing && !classes.some((klass) => klass.id === editing.class_id)) {
    classOptions.push({ value: editing.class_id, label: classCode(editing.class_id) });
  }
  const teacherOptions: SelectOption<string>[] = teachers.map((teacher) => ({
    value: teacher.id,
    label: teacher.display_name,
  }));
  const dayOptions: SelectOption<string>[] = days.map((day) => ({
    value: String(day),
    label: weekdayLabel(day, t),
  }));
  const periodOptions: SelectOption<string>[] = Array.from({ length: periodCount }, (_, index) => ({
    value: String(index + 1),
    label: t("adminSchool.timetable.slotModal.periodOption", { period: index + 1 }),
  }));

  const complete = classId !== "" && teacherId !== "";
  const saving = createSlot.isPending || updateSlot.isPending;

  function handleError(err: unknown, fallbackKey: string) {
    if (err instanceof ApiError && err.status === 409 && err.detail) {
      onConflict(err.detail);
      onClose();
      return;
    }
    show({
      variant: "error",
      title: t(fallbackKey),
      description: err instanceof ApiError ? (err.detail ?? err.title) : undefined,
    });
  }

  function handleSave() {
    if (!target || !complete) return;
    const candidate = {
      teacher_id: teacherId,
      weekday: Number(weekday),
      period: Number(period),
    };

    const conflict = findLocalConflict(
      allSlots,
      { ...candidate, excludeSlotId: editing?.id },
      classCode,
      (id) =>
        teachers.find((teacher) => teacher.id === id)?.display_name ??
        t("adminSchool.timetable.unknownTeacher"),
      t,
    );
    if (conflict) {
      onConflict(conflict.message, conflict.existingSlot.id);
      onClose();
      return;
    }

    // A lesson kept on its own class keeps that class's section even if the class has since left
    // the offered list.
    const sectionId =
      classes.find((klass) => klass.id === classId)?.section_id ??
      (editing && editing.class_id === classId ? editing.section_id : null);
    const sectionClash = findSectionClash(
      allSlots,
      {
        section_id: sectionId,
        weekday: candidate.weekday,
        period: candidate.period,
        excludeSlotId: editing?.id,
      },
      classCode,
      t,
    );
    const warnSectionClash = () => {
      if (sectionClash) onSectionClash(sectionClash.message, sectionClash.existingSlot.id);
    };

    if (editing) {
      updateSlot.mutate(
        { slotId: editing.id, versionId, body: { class_id: classId, ...candidate } },
        {
          onSuccess: () => {
            show({ variant: "success", title: t("adminSchool.timetable.toast.slotUpdated") });
            warnSectionClash();
            onClose();
          },
          onError: (err) => handleError(err, "adminSchool.timetable.toast.slotUpdateFailed"),
        },
      );
    } else {
      createSlot.mutate(
        { versionId, body: { class_id: classId, ...candidate } },
        {
          onSuccess: () => {
            show({ variant: "success", title: t("adminSchool.timetable.toast.slotAdded") });
            warnSectionClash();
            onClose();
          },
          onError: (err) => handleError(err, "adminSchool.timetable.toast.placeFailed"),
        },
      );
    }
  }

  function handleRemove() {
    if (!editing) return;
    deleteSlot.mutate(
      { slotId: editing.id, versionId },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("adminSchool.timetable.toast.slotRemoved") });
          onClose();
        },
        onError: () =>
          show({ variant: "error", title: t("adminSchool.timetable.toast.slotRemoveFailed") }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        editing
          ? t("adminSchool.timetable.editModal.title")
          : t("adminSchool.timetable.slotModal.addTitle")
      }
      description={
        editing
          ? t("adminSchool.timetable.editModal.description", {
              classCode: classCode(editing.class_id),
              day: weekdayLabel(editing.weekday, t),
              period: editing.period,
            })
          : t("adminSchool.timetable.slotModal.addDescription", {
              day: weekdayLabel(Number(weekday), t),
              period: Number(period),
            })
      }
    >
      <Modal.Body>
        <div className="timetable-slot-form">
          <Select
            label={t("adminSchool.timetable.slotModal.class")}
            options={classOptions}
            value={classId}
            onChange={handleClassChange}
            placeholder={t("adminSchool.timetable.slotModal.classPlaceholder")}
            required
          />
          <Select
            label={t("adminSchool.timetable.editModal.teacher")}
            options={teacherOptions}
            value={teacherId}
            onChange={setTeacherId}
            required
          />
          <div className="timetable-slot-form__when">
            <Select
              label={t("adminSchool.timetable.slotModal.day")}
              options={dayOptions}
              value={weekday}
              onChange={setWeekday}
              required
            />
            <Select
              label={t("adminSchool.timetable.grid.period")}
              options={periodOptions}
              value={period}
              onChange={setPeriod}
              required
            />
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        {editing ? (
          <Button
            type="button"
            variant="tertiary"
            loading={deleteSlot.isPending}
            onClick={handleRemove}
          >
            {t("adminSchool.timetable.editModal.remove")}
          </Button>
        ) : null}
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("adminSchool.timetable.editModal.cancel")}
        </Button>
        <Button type="button" loading={saving} disabled={!complete} onClick={handleSave}>
          {editing
            ? t("adminSchool.timetable.editModal.save")
            : t("adminSchool.timetable.slotModal.add")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
