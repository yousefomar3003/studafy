import { ApiError } from "@studafy/api-client";
import { Button, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { findLocalConflict } from "./conflicts";
import { weekdayLabel } from "./constants";
import { useDeleteSlot, useUpdateSlot } from "./mutations";

import type { Room, TeacherContact, TimetableSlot } from "./queries";
import type { SelectOption } from "@studafy/ui";

export interface EditSlotModalProps {
  slot: TimetableSlot | null;
  versionId: string;
  onClose: () => void;
  classCode: (classId: string) => string;
  teachers: readonly TeacherContact[];
  rooms: readonly Room[];
  allSlots: readonly TimetableSlot[];
  onConflict: (message: string) => void;
}

/** Editing an existing slot's teacher/room, or removing it. Moving a slot to a different
 * weekday/period isn't supported here — remove it and drag/place a new one instead, which keeps this
 * form to the two fields that don't also require re-running the drop interaction. */
export function EditSlotModal({
  slot,
  versionId,
  onClose,
  classCode,
  teachers,
  rooms,
  allSlots,
  onConflict,
}: EditSlotModalProps) {
  const { show } = useToast();
  const updateSlot = useUpdateSlot();
  const deleteSlot = useDeleteSlot();

  const [teacherId, setTeacherId] = useState("");
  const [roomId, setRoomId] = useState("");

  useEffect(() => {
    if (slot) {
      setTeacherId(slot.teacher_id);
      setRoomId(slot.room_id);
    }
  }, [slot]);

  if (!slot) {
    return null;
  }

  const teacherOptions: SelectOption<string>[] = teachers.map((teacher) => ({
    value: teacher.id,
    label: teacher.display_name,
  }));
  // A slot's current room stays selectable even if it has since been deactivated — dropping it from
  // the list here would silently blank the field.
  const roomOptions: SelectOption<string>[] = rooms
    .filter((room) => room.is_active || room.id === slot.room_id)
    .map((room) => ({ value: room.id, label: `${room.code} — ${room.name}` }));

  function handleSave() {
    if (!slot) return;

    const conflict = findLocalConflict(
      allSlots,
      {
        teacher_id: teacherId,
        room_id: roomId,
        weekday: slot.weekday,
        period: slot.period,
        excludeSlotId: slot.id,
      },
      classCode,
      (id) => teachers.find((t) => t.id === id)?.display_name ?? "Unknown teacher",
      (id) => rooms.find((r) => r.id === id)?.code ?? "Unknown room",
    );
    if (conflict) {
      onConflict(conflict.message);
      return;
    }

    updateSlot.mutate(
      { slotId: slot.id, versionId, body: { teacher_id: teacherId, room_id: roomId } },
      {
        onSuccess: () => {
          show({ variant: "success", title: "Slot updated" });
          onClose();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.detail) {
            onConflict(err.detail);
            return;
          }
          show({ variant: "error", title: "Couldn't update slot" });
        },
      },
    );
  }

  function handleRemove() {
    if (!slot) return;
    deleteSlot.mutate(
      { slotId: slot.id, versionId },
      {
        onSuccess: () => {
          show({ variant: "success", title: "Slot removed" });
          onClose();
        },
        onError: () => show({ variant: "error", title: "Couldn't remove slot" }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit slot"
      description={`${classCode(slot.class_id)} — ${weekdayLabel(slot.weekday)}, period ${slot.period}`}
    >
      <Modal.Body>
        <Select
          label="Teacher"
          options={teacherOptions}
          value={teacherId}
          onChange={setTeacherId}
          required
        />
        <Select label="Room" options={roomOptions} value={roomId} onChange={setRoomId} required />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={deleteSlot.isPending}
          onClick={handleRemove}
        >
          Remove
        </Button>
        <Button type="button" loading={updateSlot.isPending} onClick={handleSave}>
          Save changes
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
