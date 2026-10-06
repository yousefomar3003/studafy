import { ApiError } from "@studafy/api-client";
import { Button, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { findLocalConflict } from "./conflicts";
import { WEEKDAYS } from "./constants";
import { useCreateSlot } from "./mutations";
import { SlotModal } from "./SlotModal";

import type { Class, Room, TeacherContact, TimetableSlot, TimetableVersion } from "./queries";
import type { SlotModalTarget } from "./SlotModal";
import type { DragEvent, KeyboardEvent } from "react";

export interface TimetableGridProps {
  version: TimetableVersion;
  /** Every slot of the version — clash checks always run against all of them, filtered or not. */
  slots: readonly TimetableSlot[];
  classes: readonly Class[];
  teachers: readonly TeacherContact[];
  rooms: readonly Room[];
  isReadOnly: boolean;
  /** The school's teaching days in display order (1=Mon..7=Sun). */
  days: readonly number[];
  /** Periods per teaching day. */
  periodCount: number;
  /** Narrows which slots render (class/teacher filter). Omitted shows them all. */
  isVisible?: (slot: TimetableSlot) => boolean;
}

interface ConflictState {
  message: string;
  existingSlotId?: string;
}

/** Number of lesson colours in timetable.css (`[data-tone="0".."7"]`). */
const TONE_COUNT = 8;

function cellKey(weekday: number, period: number): string {
  return `${weekday}-${period}`;
}

/** ISO weekday (1=Mon..7=Sun) of `date` in the viewer's time zone. */
function isoWeekday(date: Date): number {
  return date.getDay() === 0 ? 7 : date.getDay();
}

/**
 * Weekly timetable grid: the school's teaching days across, its periods down. A weekday/period cell
 * is one school-wide time slot, not a single class's seat — several classes legitimately run at once
 * (different teacher, different room), so each cell holds a *list* of lessons. What the `EXCLUDE`
 * constraints (and this component's own `findLocalConflict` pre-check) forbid is a given *teacher* or
 * *room* appearing twice at the same weekday/period, searched across the whole version.
 *
 * Editing: every empty slot of a cell offers "+", which opens the lesson form for that day and
 * period; clicking a lesson opens the same form to change or remove it. Classes also live in a
 * palette — drag one onto a cell (pointer), or pick it with Enter/Space and then activate a cell
 * (keyboard) — which places it straight away with the class's usual teacher and room.
 *
 * A day that isn't in the school week but still has lessons (the week was changed after they were
 * scheduled) keeps its column, so no lesson is ever hidden by the settings.
 */
export function TimetableGrid({
  version,
  slots,
  classes,
  teachers,
  rooms,
  isReadOnly,
  days,
  periodCount,
  isVisible,
}: TimetableGridProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createSlot = useCreateSlot();

  const [pickedClassId, setPickedClassId] = useState<string | null>(null);
  const [modalTarget, setModalTarget] = useState<SlotModalTarget | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  const classById = useMemo(() => new Map(classes.map((klass) => [klass.id, klass])), [classes]);
  const teacherById = useMemo(() => new Map(teachers.map((t) => [t.id, t])), [teachers]);
  const roomById = useMemo(() => new Map(rooms.map((r) => [r.id, r])), [rooms]);

  // One colour per course, so every section of the same subject reads alike across the week.
  // Assigned by sorted course id rather than hashed, so a small school never gets two courses
  // sharing a colour until it has more than TONE_COUNT of them.
  const toneByClassId = useMemo(() => {
    const courseIds = [...new Set(classes.map((klass) => klass.course_id))].sort();
    const toneByCourse = new Map(courseIds.map((id, index) => [id, index % TONE_COUNT]));
    return new Map(classes.map((klass) => [klass.id, toneByCourse.get(klass.course_id) ?? 0]));
  }, [classes]);

  const visibleSlots = useMemo(
    () => (isVisible ? slots.filter(isVisible) : slots),
    [slots, isVisible],
  );

  const slotsByCell = useMemo(() => {
    const map = new Map<string, TimetableSlot[]>();
    for (const slot of visibleSlots) {
      const key = cellKey(slot.weekday, slot.period);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(slot);
      } else {
        map.set(key, [slot]);
      }
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) =>
        (classById.get(a.class_id)?.code ?? "").localeCompare(
          classById.get(b.class_id)?.code ?? "",
        ),
      );
    }
    return map;
  }, [visibleSlots, classById]);

  const displayDays = useMemo(() => {
    const extra = [...new Set(slots.map((slot) => slot.weekday))]
      .filter((day) => !days.includes(day))
      .sort((a, b) => a - b);
    return [...days, ...extra]
      .map((value) => WEEKDAYS.find((day) => day.value === value))
      .filter((day): day is (typeof WEEKDAYS)[number] => day !== undefined);
  }, [days, slots]);

  const rowCount = Math.max(periodCount, ...slots.map((slot) => slot.period), 1);
  const periods = Array.from({ length: rowCount }, (_, index) => index + 1);
  const today = isoWeekday(new Date());

  function classCode(classId: string): string {
    return classById.get(classId)?.code ?? t("adminSchool.timetable.unknownClass");
  }
  function teacherName(teacherId: string): string {
    return teacherById.get(teacherId)?.display_name ?? t("adminSchool.timetable.unknownTeacher");
  }
  function roomCode(roomId: string): string {
    return roomById.get(roomId)?.code ?? t("adminSchool.timetable.unknownRoom");
  }

  const pickedClass = pickedClassId ? (classById.get(pickedClassId) ?? null) : null;

  function assignSlot(classId: string, weekday: number, period: number) {
    const klass = classById.get(classId);
    if (!klass) return;

    const candidate = {
      teacher_id: klass.lead_teacher_id,
      room_id: klass.room_id,
      weekday,
      period,
    };
    const localConflict = findLocalConflict(slots, candidate, classCode, teacherName, roomCode, t);
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
          show({ variant: "error", title: t("adminSchool.timetable.toast.placeFailed") });
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
    <div
      className="timetable-grid"
      onKeyDown={onGridKeyDown}
      data-editing={!isReadOnly || undefined}
    >
      {conflict ? (
        <div className="timetable-grid__conflict" role="alert">
          <span>{conflict.message}</span>
          <Button variant="tertiary" onClick={() => setConflict(null)}>
            {t("adminSchool.timetable.grid.dismiss")}
          </Button>
        </div>
      ) : null}

      {!isReadOnly ? (
        <div
          className="timetable-grid__palette"
          aria-label={t("adminSchool.timetable.grid.classes")}
        >
          <div className="timetable-grid__palette-head">
            <h2>{t("adminSchool.timetable.grid.classes")}</h2>
            <p role="status" className="timetable-grid__palette-status">
              {pickedClass
                ? t("adminSchool.timetable.grid.picked", { code: pickedClass.code })
                : t("adminSchool.timetable.grid.instructions")}
            </p>
          </div>
          <ul className="timetable-grid__palette-list">
            {classes.map((klass) => (
              <li key={klass.id}>
                <button
                  type="button"
                  className="timetable-grid__chip"
                  data-tone={toneByClassId.get(klass.id)}
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
                {t("adminSchool.timetable.grid.noClasses")}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div className="timetable-grid__scroller">
        <table className="timetable-grid__table">
          <caption className="sf-visually-hidden">
            {t("adminSchool.timetable.grid.caption", { name: version.name })}
          </caption>
          <colgroup>
            <col className="timetable-grid__period-col" />
            {displayDays.map((day) => (
              <col key={day.value} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="timetable-grid__corner">
                {t("adminSchool.timetable.grid.period")}
              </th>
              {displayDays.map((day) => (
                <th
                  scope="col"
                  key={day.value}
                  data-today={day.value === today || undefined}
                  data-off-week={!days.includes(day.value) || undefined}
                >
                  <abbr title={t(day.labelKey)}>{t(day.shortKey)}</abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr key={period}>
                <th scope="row" className="timetable-grid__period">
                  {period}
                </th>
                {displayDays.map((day) => {
                  const cellSlots = slotsByCell.get(cellKey(day.value, period)) ?? [];
                  const dayLabel = t(day.labelKey);

                  return (
                    <td key={day.value} data-today={day.value === today || undefined}>
                      <div className="timetable-grid__cell">
                        {cellSlots.map((slot) => (
                          <button
                            key={slot.id}
                            type="button"
                            className="timetable-grid__slot"
                            data-tone={toneByClassId.get(slot.class_id) ?? 0}
                            data-conflict={conflict?.existingSlotId === slot.id || undefined}
                            disabled={isReadOnly}
                            onClick={() => setModalTarget({ kind: "edit", slot })}
                            aria-label={t("adminSchool.timetable.grid.slotLabel", {
                              classCode: classCode(slot.class_id),
                              day: dayLabel,
                              period,
                              teacher: teacherName(slot.teacher_id),
                              room: roomCode(slot.room_id),
                            })}
                          >
                            <span className="timetable-grid__slot-class">
                              {classCode(slot.class_id)}
                            </span>
                            <span className="timetable-grid__slot-meta">
                              {teacherName(slot.teacher_id)}
                            </span>
                            <span className="timetable-grid__slot-room">
                              {roomCode(slot.room_id)}
                            </span>
                          </button>
                        ))}

                        {!isReadOnly ? (
                          <button
                            type="button"
                            className="timetable-grid__drop-target"
                            data-picking={pickedClass ? true : undefined}
                            onDragOver={onDragOverCell}
                            onDrop={(event) => onDropCell(event, day.value, period)}
                            onClick={() => {
                              if (pickedClassId) {
                                assignSlot(pickedClassId, day.value, period);
                              } else {
                                setModalTarget({ kind: "add", weekday: day.value, period });
                              }
                            }}
                            aria-label={
                              pickedClass
                                ? t("adminSchool.timetable.grid.placeLabel", {
                                    code: pickedClass.code,
                                    day: dayLabel,
                                    period,
                                  })
                                : t("adminSchool.timetable.grid.addLabel", {
                                    day: dayLabel,
                                    period,
                                  })
                            }
                          >
                            <span aria-hidden="true">+</span>
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
      </div>

      <SlotModal
        target={modalTarget}
        versionId={version.id}
        onClose={() => setModalTarget(null)}
        classes={classes}
        teachers={teachers}
        rooms={rooms}
        allSlots={slots}
        days={displayDays.map((day) => day.value)}
        periodCount={rowCount}
        classCode={classCode}
        onConflict={(message, existingSlotId) => setConflict({ message, existingSlotId })}
      />
    </div>
  );
}
