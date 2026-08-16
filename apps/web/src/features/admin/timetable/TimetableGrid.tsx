import { ApiError } from "@studafy/api-client";
import { Button, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { findLocalConflict } from "./conflicts";
import { DEFAULT_PERIOD_COUNT, WEEKDAYS } from "./constants";
import { EditSlotModal } from "./EditSlotModal";
import { useCreateSlot } from "./mutations";

import type { Class, Room, TeacherContact, TimetableSlot, TimetableVersion } from "./queries";
import type { DragEvent, KeyboardEvent } from "react";

export interface TimetableGridProps {
  version: TimetableVersion;
  slots: readonly TimetableSlot[];
  classes: readonly Class[];
  teachers: readonly TeacherContact[];
  rooms: readonly Room[];
  isReadOnly: boolean;
}

interface ConflictState {
  message: string;
  existingSlotId?: string;
}

function cellKey(weekday: number, period: number): string {
  return `${weekday}-${period}`;
}

/**
 * Weekly grid editor. A weekday/period cell is one school-wide time slot, not a single class's
 * seat — several classes legitimately run at once (different teacher, different room), so each cell
 * holds a *list* of slots, not at most one. What the `EXCLUDE` constraints (and this component's own
 * `findLocalConflict` pre-check) actually forbid is a given *teacher* or *room* appearing twice at the
 * same weekday/period, searched across the whole version's slots — not "this cell already has
 * something in it."
 *
 * Classes live in a "palette" tray; assigning one to a cell (drag-and-drop for pointer users,
 * pick-then-place for keyboard users — both funnel through the same `assignSlot`) seeds a slot from
 * that class's default teacher/room, editable afterward via the cell's own modal.
 *
 * Keyboard access doesn't need a custom ARIA grid/roving-tabindex pattern: every interactive surface
 * (palette chip, slot chip, drop target) is a plain `<button>`, which is Tab-reachable and
 * Enter/Space-activatable by default. "Pick" a class (click or Enter/Space on its chip, toggling
 * `aria-pressed`), then activate a cell's drop target the same way to place it — the keyboard
 * equivalent of the drag gesture, not a bolted-on afterthought.
 */
export function TimetableGrid({
  version,
  slots,
  classes,
  teachers,
  rooms,
  isReadOnly,
}: TimetableGridProps) {
  const { show } = useToast();
  const createSlot = useCreateSlot();

  const [pickedClassId, setPickedClassId] = useState<string | null>(null);
  const [editingSlot, setEditingSlot] = useState<TimetableSlot | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [periodCount, setPeriodCount] = useState(() =>
    Math.max(DEFAULT_PERIOD_COUNT, ...slots.map((slot) => slot.period), 0),
  );

  const classById = useMemo(() => new Map(classes.map((klass) => [klass.id, klass])), [classes]);
  const teacherById = useMemo(() => new Map(teachers.map((t) => [t.id, t])), [teachers]);
  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  const slotsByCell = useMemo(() => {
    const map = new Map<string, TimetableSlot[]>();
    for (const slot of slots) {
      const key = cellKey(slot.weekday, slot.period);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(slot);
      } else {
        map.set(key, [slot]);
      }
    }
    return map;
  }, [slots]);

  function classCode(classId: string): string {
    return classById.get(classId)?.code ?? "Unknown class";
  }
  function teacherName(teacherId: string): string {
    return teacherById.get(teacherId)?.display_name ?? "Unknown teacher";
  }
  function roomCode(roomId: string): string {
    return roomById.get(roomId)?.code ?? "Unknown room";
  }

  const pickedClass = pickedClassId ? (classById.get(pickedClassId) ?? null) : null;
  const periods = Array.from({ length: periodCount }, (_, index) => index + 1);
  const lastPeriodIsEmpty =
    periods.length > 0 && !slots.some((slot) => slot.period === periodCount);

  function assignSlot(classId: string, weekday: number, period: number) {
    const klass = classById.get(classId);
    if (!klass) return;

    const candidate = {
      teacher_id: klass.lead_teacher_id,
      room_id: klass.room_id,
      weekday,
      period,
    };
    const localConflict = findLocalConflict(slots, candidate, classCode, teacherName, roomCode);
    if (localConflict) {
      setConflict({
        message: localConflict.message,
        existingSlotId: localConflict.existingSlot.id,
      });
      return;
    }

    createSlot.mutate(
      {
        versionId: version.id,
        body: { class_id: classId, ...candidate },
      },
      {
        onSuccess: () => setConflict(null),
        onError: (err) => {
          if (err instanceof ApiError && err.detail) {
            setConflict({ message: err.detail });
            return;
          }
          show({ variant: "error", title: "Couldn't place slot" });
        },
      },
    );
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && pickedClassId) {
      setPickedClassId(null);
    }
  }

  function onDragOverCell(event: DragEvent<HTMLButtonElement>) {
    if (isReadOnly) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDropCell(event: DragEvent<HTMLButtonElement>, weekday: number, period: number) {
    if (isReadOnly) return;
    event.preventDefault();
    const classId = event.dataTransfer.getData("text/plain");
    if (classId) assignSlot(classId, weekday, period);
  }

  return (
    <div className="timetable-grid" onKeyDown={onGridKeyDown}>
      {conflict ? (
        <div className="timetable-grid__conflict" role="alert">
          <span>{conflict.message}</span>
          <Button variant="tertiary" onClick={() => setConflict(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {!isReadOnly ? (
        <div className="timetable-grid__palette" aria-label="Classes">
          <h2>Classes</h2>
          <p role="status" className="timetable-grid__palette-status">
            {pickedClass
              ? `${pickedClass.code} picked — choose a cell to place it, or press Escape to cancel.`
              : "Drag a class onto the grid, or press Enter to pick it up and then Enter on a cell."}
          </p>
          <ul className="timetable-grid__palette-list">
            {classes.map((klass) => (
              <li key={klass.id}>
                <button
                  type="button"
                  className="timetable-grid__chip"
                  draggable
                  aria-pressed={pickedClassId === klass.id}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", klass.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() =>
                    setPickedClassId((current) => (current === klass.id ? null : klass.id))
                  }
                >
                  {klass.code}
                </button>
              </li>
            ))}
            {classes.length === 0 ? (
              <li className="timetable-grid__palette-empty">
                No schedulable classes in this term.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <table className="timetable-grid__table">
        <caption className="sf-visually-hidden">Weekly timetable grid for {version.name}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {WEEKDAYS.map((day) => (
              <th scope="col" key={day.value}>
                {day.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((period) => (
            <tr key={period}>
              <th scope="row">{period}</th>
              {WEEKDAYS.map((day) => {
                const cellSlots = slotsByCell.get(cellKey(day.value, period)) ?? [];

                return (
                  <td key={day.value}>
                    <div className="timetable-grid__cell">
                      {cellSlots.map((slot) => (
                        <button
                          key={slot.id}
                          type="button"
                          className="timetable-grid__slot"
                          data-conflict={conflict?.existingSlotId === slot.id || undefined}
                          disabled={isReadOnly}
                          onClick={() => setEditingSlot(slot)}
                          aria-label={`${classCode(slot.class_id)}, ${day.label} period ${period}, taught by ${teacherName(slot.teacher_id)} in ${roomCode(slot.room_id)}. Activate to edit.`}
                        >
                          <span className="timetable-grid__slot-class">
                            {classCode(slot.class_id)}
                          </span>
                          <span className="timetable-grid__slot-meta">
                            {teacherName(slot.teacher_id)}
                          </span>
                          <span className="timetable-grid__slot-meta">
                            {roomCode(slot.room_id)}
                          </span>
                        </button>
                      ))}

                      {!isReadOnly ? (
                        <button
                          type="button"
                          className="timetable-grid__drop-target"
                          onDragOver={onDragOverCell}
                          onDrop={(event) => onDropCell(event, day.value, period)}
                          onClick={() => {
                            if (pickedClassId) assignSlot(pickedClassId, day.value, period);
                          }}
                          aria-label={
                            pickedClass
                              ? `Place ${pickedClass.code} on ${day.label} period ${period}`
                              : `${day.label} period ${period}${cellSlots.length > 0 ? `, ${cellSlots.length} scheduled` : ", empty"}`
                          }
                        >
                          +
                        </button>
                      ) : null}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {!isReadOnly ? (
        <div className="timetable-grid__period-controls">
          <Button variant="secondary" onClick={() => setPeriodCount((count) => count + 1)}>
            Add period
          </Button>
          {periods.length > 1 && lastPeriodIsEmpty ? (
            <Button variant="tertiary" onClick={() => setPeriodCount((count) => count - 1)}>
              Remove empty period
            </Button>
          ) : null}
        </div>
      ) : null}

      <EditSlotModal
        slot={editingSlot}
        versionId={version.id}
        onClose={() => setEditingSlot(null)}
        classCode={classCode}
        teachers={teachers}
        rooms={rooms}
        allSlots={slots}
        onConflict={(message) => setConflict({ message })}
      />
    </div>
  );
}
