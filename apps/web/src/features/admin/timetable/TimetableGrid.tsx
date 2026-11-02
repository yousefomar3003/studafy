import { ApiError } from "@studafy/api-client";
import { Button, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { findLocalConflict, findSectionClash } from "./conflicts";
import { WEEKDAYS } from "./constants";
import { useCreateSlot } from "./mutations";
import { compactSectionLabel } from "./queries";
import { SlotModal } from "./SlotModal";

import type { Class, TeacherContact, TimetableSlot, TimetableVersion } from "./queries";
import type { SlotModalTarget } from "./SlotModal";
import type { DragEvent, KeyboardEvent } from "react";

export interface TimetableGridProps {
  version: TimetableVersion;
  /** Every slot of the version — clash checks always run against all of them, filtered or not. */
  slots: readonly TimetableSlot[];
  classes: readonly Class[];
  teachers: readonly TeacherContact[];
  isReadOnly: boolean;
  /** The school's teaching days in display order (1=Mon..7=Sun). */
  days: readonly number[];
  /** Periods per teaching day. */
  periodCount: number;
  /** Narrows which slots render (grade/section/teacher filter). Omitted shows them all. */
  isVisible?: (slot: TimetableSlot) => boolean;
  /** The section the view is filtered to: the palette and lesson form offer only its classes, and
   * lessons drop their (then redundant) section label. */
  sectionId?: string;
}

interface ConflictState {
  message: string;
  existingSlotId?: string;
  /** A section double-booking: the lesson was placed, so this only asks for a second look. */
  warning?: boolean;
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
 * (different teacher, different section), so each cell holds a *list* of lessons. What the `EXCLUDE`
 * constraint (and this component's own `findLocalConflict` pre-check) forbids is a given *teacher*
 * appearing twice at the same weekday/period, searched across the whole version. A grade
 * *section* booked twice at once is allowed but flagged with a warning (see `findSectionClash`).
 *
 * Editing: every empty slot of a cell offers "+", which opens the lesson form for that day and
 * period; clicking a lesson opens the same form to change or remove it. Classes also live in a
 * palette — drag one onto a cell (pointer), or pick it with Enter/Space and then activate a cell
 * (keyboard) — which places it straight away with the class's usual teacher.
 *
 * A day that isn't in the school week but still has lessons (the week was changed after they were
 * scheduled) keeps its column, so no lesson is ever hidden by the settings.
 */
export function TimetableGrid({
  version,
  slots,
  classes,
  teachers,
  isReadOnly,
  days,
  periodCount,
  isVisible,
  sectionId,
}: TimetableGridProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createSlot = useCreateSlot();

  const [pickedClassId, setPickedClassId] = useState<string | null>(null);
  const [modalTarget, setModalTarget] = useState<SlotModalTarget | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  const classById = useMemo(() => new Map(classes.map((klass) => [klass.id, klass])), [classes]);
  const teacherById = useMemo(() => new Map(teachers.map((t) => [t.id, t])), [teachers]);

  // One colour per course, so every section of the same subject reads alike across the week.
  // Assigned by sorted course id rather than hashed, so a small school never gets two courses
  // sharing a colour until it has more than TONE_COUNT of them.
  const toneByClassId = useMemo(() => {
    const courseIds = [...new Set(classes.map((klass) => klass.course_id))].sort();
    const toneByCourse = new Map(courseIds.map((id, index) => [id, index % TONE_COUNT]));
    return new Map(classes.map((klass) => [klass.id, toneByCourse.get(klass.course_id) ?? 0]));
  }, [classes]);

  const offeredClasses = useMemo(
    () => (sectionId ? classes.filter((klass) => klass.section_id === sectionId) : classes),
    [classes, sectionId],
  );

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

  // A pick lapses when a section filter change takes the class out of the palette.
  const pickedClass = pickedClassId
    ? (offeredClasses.find((klass) => klass.id === pickedClassId) ?? null)
    : null;

  function assignSlot(classId: string, weekday: number, period: number) {
    const klass = classById.get(classId);
    if (!klass) return;

    const candidate = {
      teacher_id: klass.lead_teacher_id,
      weekday,
      period,
    };
    const localConflict = findLocalConflict(slots, candidate, classCode, teacherName, t);
    if (localConflict) {
      setConflict({
        message: localConflict.message,
        existingSlotId: localConflict.existingSlot.id,
      });
      return;
    }
    const sectionClash = findSectionClash(
      slots,
      { section_id: klass.section_id, weekday, period },
      classCode,
      t,
    );

    createSlot.mutate(
      {
        versionId: version.id,
        body: { class_id: classId, ...candidate },
      },
      {
        onSuccess: () =>
          setConflict(
            sectionClash
              ? {
                  message: sectionClash.message,
                  existingSlotId: sectionClash.existingSlot.id,
                  warning: true,
                }
              : null,
          ),
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
        <div
          className="timetable-grid__conflict"
          role={conflict.warning ? "status" : "alert"}
          data-tone={conflict.warning ? "warning" : undefined}
        >
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
            {offeredClasses.map((klass) => (
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
            {offeredClasses.length === 0 ? (
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
                        {cellSlots.map((slot) => {
                          const section = sectionId
                            ? null
                            : compactSectionLabel(slot.grade_level_name, slot.section_name);
                          const labelParams = {
                            classCode: classCode(slot.class_id),
                            day: dayLabel,
                            period,
                            teacher: teacherName(slot.teacher_id),
                            section,
                          };
                          return (
                            <button
                              key={slot.id}
                              type="button"
                              className="timetable-grid__slot"
                              data-tone={toneByClassId.get(slot.class_id) ?? 0}
                              data-conflict={
                                conflict?.existingSlotId === slot.id
                                  ? conflict.warning
                                    ? "warning"
                                    : true
                                  : undefined
                              }
                              disabled={isReadOnly}
                              onClick={() => setModalTarget({ kind: "edit", slot })}
                              aria-label={
                                section
                                  ? t("adminSchool.timetable.grid.slotLabelSection", labelParams)
                                  : t("adminSchool.timetable.grid.slotLabel", labelParams)
                              }
                            >
                              <span className="timetable-grid__slot-class">
                                {classCode(slot.class_id)}
                              </span>
                              <span className="timetable-grid__slot-meta">
                                {teacherName(slot.teacher_id)}
                              </span>
                              {section ? (
                                <span className="timetable-grid__slot-section">{section}</span>
                              ) : null}
                            </button>
                          );
                        })}

                        {!isReadOnly ? (
                          <button
                            type="button"
                            className="timetable-grid__drop-target"
                            data-picking={pickedClass ? true : undefined}
                            onDragOver={onDragOverCell}
                            onDrop={(event) => onDropCell(event, day.value, period)}
                            onClick={() => {
                              if (pickedClass) {
                                assignSlot(pickedClass.id, day.value, period);
                              } else {
                                setModalTarget({
                                  kind: "add",
                                  weekday: day.value,
                                  period,
                                  klass:
                                    offeredClasses.length === 1 ? offeredClasses[0] : undefined,
                                });
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
        classes={offeredClasses}
        teachers={teachers}
        allSlots={slots}
        days={displayDays.map((day) => day.value)}
        periodCount={rowCount}
        classCode={classCode}
        onConflict={(message, existingSlotId) => setConflict({ message, existingSlotId })}
        onSectionClash={(message, existingSlotId) =>
          setConflict({ message, existingSlotId, warning: true })
        }
      />
    </div>
  );
}
