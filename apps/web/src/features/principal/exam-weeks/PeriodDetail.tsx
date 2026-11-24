import { Button, Checkbox, Input, Modal, Select, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { ConfirmModal, SeverityBadge } from "../academic-setup/components";
import { problemMessage } from "../academic-setup/errors";
import { useSubjects, useTeacherContacts } from "../school/queries";
import { useSections } from "../sections/queries";

import { formatDay } from "./format";
import { draftOf, PeriodFormModal, periodBody, PeriodStatusBadge } from "./PeriodForm";
import { PrintSheets } from "./PrintSheets";
import {
  useDeleteExamSlot,
  useExamPeriod,
  useExamPeriodClashes,
  useGradeAssessments,
  useRooms,
  useSaveExamPeriod,
  useSaveExamSlot,
  useSetInvigilators,
} from "./queries";
import { SeatingModal } from "./SeatingModal";

import type { YearRef } from "./PeriodForm";
import type { ExamClash, ExamPeriod, ExamSlot, ExamSlotInput } from "./queries";
import type { TFunction } from "i18next";
import type { FormEvent } from "react";

type Dialog =
  | { kind: "period" }
  | { kind: "slot"; slot: ExamSlot | null }
  | { kind: "seating"; slot: ExamSlot }
  | { kind: "invigilators"; slot: ExamSlot }
  | { kind: "delete"; slot: ExamSlot };

/** One exam period: its timetable, clashes, publishing and printing. */
export function PeriodDetail({
  periodId,
  year,
  onBack,
}: {
  periodId: string;
  year: YearRef;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const period = useExamPeriod(periodId);
  const clashes = useExamPeriodClashes(periodId);
  const savePeriod = useSaveExamPeriod();
  const removeSlot = useDeleteExamSlot();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [printing, setPrinting] = useState<"lists" | "doors" | null>(null);

  if (period.isPending) {
    return (
      <p className="ag-muted" role="status">
        {t("examWeeks.loading")}
      </p>
    );
  }
  if (period.isError || !period.data) {
    return (
      <>
        <Button type="button" variant="tertiary" onClick={onBack}>
          {t("examWeeks.detail.back")}
        </Button>
        <p className="ag-error" role="alert">
          {problemMessage(period.error, t)}
        </p>
      </>
    );
  }
  const data = period.data;

  if (printing) {
    return <PrintSheets period={data} kind={printing} onDone={() => setPrinting(null)} />;
  }

  const publish = (status: "draft" | "published") =>
    savePeriod.mutate(
      { periodId: data.id, body: periodBody(year.id, draftOf(data), status) },
      {
        onSuccess: () =>
          show({
            variant: "success",
            title:
              status === "published"
                ? t("examWeeks.detail.published")
                : t("examWeeks.detail.unpublished"),
          }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("examWeeks.detail.publishFailed"),
            description: problemMessage(error, t),
          }),
      },
    );

  return (
    <>
      <Button type="button" variant="tertiary" onClick={onBack}>
        {t("examWeeks.detail.back")}
      </Button>
      <div className="principal-school__header">
        <h1>{data.name}</h1>
        <PeriodStatusBadge status={data.status} />
      </div>
      <PeriodFacts period={data} />
      <div className="ag-row__actions ew-actions">
        <Button type="button" variant="secondary" onClick={() => setDialog({ kind: "period" })}>
          {t("examWeeks.detail.editPeriod")}
        </Button>
        {data.status === "draft" ? (
          <Button
            type="button"
            disabled={savePeriod.isPending}
            onClick={() => publish("published")}
          >
            {t("examWeeks.detail.publish")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled={savePeriod.isPending}
            onClick={() => publish("draft")}
          >
            {t("examWeeks.detail.unpublish")}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={data.slots.length === 0}
          onClick={() => setPrinting("lists")}
        >
          {t("examWeeks.detail.printLists")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={data.slots.length === 0}
          onClick={() => setPrinting("doors")}
        >
          {t("examWeeks.detail.printDoors")}
        </Button>
      </div>
      <p className="ag-muted">
        {data.status === "draft"
          ? t("examWeeks.detail.draftHelp")
          : t("examWeeks.detail.publishedHelp")}
      </p>

      <ClashesBlock
        period={data}
        clashes={clashes.data ?? []}
        pending={clashes.isPending}
        error={clashes.error}
      />

      <section className="ag-block" aria-labelledby="ew-slots-heading">
        <div className="ag-head">
          <h2 id="ew-slots-heading">{t("examWeeks.slots.heading")}</h2>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setDialog({ kind: "slot", slot: null })}
          >
            {t("examWeeks.slots.add")}
          </Button>
        </div>
        <SlotsTable period={data} onAction={setDialog} />
      </section>

      {dialog?.kind === "period" ? (
        <PeriodFormModal year={year} period={data} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "slot" ? (
        <SlotFormModal period={data} slot={dialog.slot} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "seating" ? (
        <SeatingModal period={data} slot={dialog.slot} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "invigilators" ? (
        <InvigilatorsModal slot={dialog.slot} onClose={() => setDialog(null)} />
      ) : null}
      <ConfirmModal
        open={dialog?.kind === "delete"}
        title={t("examWeeks.slots.deleteTitle", {
          name: dialog?.kind === "delete" ? dialog.slot.subject.name : "",
        })}
        description={t("examWeeks.slots.deleteDescription")}
        confirmLabel={t("examWeeks.common.delete")}
        submitting={removeSlot.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() =>
          dialog?.kind === "delete" &&
          removeSlot.mutate(dialog.slot.id, {
            onSuccess: () => {
              show({ variant: "success", title: t("examWeeks.slots.deleted") });
              setDialog(null);
            },
            onError: (error) => {
              show({
                variant: "error",
                title: t("examWeeks.slots.deleteFailed"),
                description: problemMessage(error, t),
              });
              setDialog(null);
            },
          })
        }
      />
    </>
  );
}

function PeriodFacts({ period }: { period: ExamPeriod }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  return (
    <p>
      {t(`examWeeks.kinds.${period.kind}`)} · {formatDay(period.starts_on, formatDate)} –{" "}
      {formatDay(period.ends_on, formatDate)}
      {period.term ? ` · ${period.term.name}` : ""} ·{" "}
      {period.grade_levels.map((grade) => grade.name).join(", ")}
    </p>
  );
}

function SlotsTable({
  period,
  onAction,
}: {
  period: ExamPeriod;
  onAction: (dialog: Dialog) => void;
}) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  return (
    <Table caption={t("examWeeks.slots.caption")} hideCaption>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{t("examWeeks.slots.columns.when")}</Table.HeaderCell>
          <Table.HeaderCell>{t("examWeeks.slots.columns.exam")}</Table.HeaderCell>
          <Table.HeaderCell>{t("examWeeks.slots.columns.rooms")}</Table.HeaderCell>
          <Table.HeaderCell>{t("examWeeks.slots.columns.seated")}</Table.HeaderCell>
          <Table.HeaderCell>{t("examWeeks.slots.columns.actions")}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body columnCount={5} empty={t("examWeeks.slots.empty")}>
        {period.slots.map((slot) => (
          <Table.Row key={slot.id}>
            <Table.Cell>
              {formatDay(slot.exam_date, formatDate, {
                weekday: "short",
                day: "numeric",
                month: "short",
              })}
              <div className="ag-muted" dir="ltr">
                {slot.starts_at}–{slot.ends_at}
              </div>
            </Table.Cell>
            <Table.Cell>
              <strong>{slot.subject.name}</strong>
              <div className="ag-muted">
                {slot.grade_level.name} · {slot.sections.map((section) => section.name).join(", ")}
              </div>
              {slot.assessment ? (
                <div className="ag-muted">
                  {t("examWeeks.slots.assessment", { name: slot.assessment.name })}
                </div>
              ) : null}
            </Table.Cell>
            <Table.Cell>
              {slot.rooms.length === 0 ? (
                <span className="ag-muted">{t("examWeeks.slots.noRooms")}</span>
              ) : (
                <ul className="ew-room-list">
                  {slot.rooms.map((room) => (
                    <li key={room.id}>
                      {room.name}{" "}
                      <span className="ag-muted">
                        {t("examWeeks.slots.roomFill", {
                          seated: formatNumber(room.seated),
                          capacity: room.capacity === null ? "—" : formatNumber(room.capacity),
                        })}
                      </span>
                      <div className="ag-muted">
                        {room.invigilators.length > 0
                          ? room.invigilators.map((teacher) => teacher.name).join(", ")
                          : t("examWeeks.slots.noInvigilator")}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Table.Cell>
            <Table.Cell>
              {t("examWeeks.slots.seatedOf", {
                seated: formatNumber(slot.seated),
                candidates: formatNumber(slot.candidates),
              })}
            </Table.Cell>
            <Table.Cell>
              <div className="sections-page__row-actions">
                <Button
                  type="button"
                  variant="secondary"
                  aria-label={t("examWeeks.slots.seatingLabel", { name: slot.subject.name })}
                  disabled={slot.rooms.length === 0}
                  onClick={() => onAction({ kind: "seating", slot })}
                >
                  {t("examWeeks.slots.seating")}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  aria-label={t("examWeeks.slots.invigilatorsLabel", { name: slot.subject.name })}
                  disabled={slot.rooms.length === 0}
                  onClick={() => onAction({ kind: "invigilators", slot })}
                >
                  {t("examWeeks.slots.invigilators")}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  aria-label={t("examWeeks.slots.editLabel", { name: slot.subject.name })}
                  onClick={() => onAction({ kind: "slot", slot })}
                >
                  {t("examWeeks.common.edit")}
                </Button>
                <Button
                  type="button"
                  variant="tertiary"
                  aria-label={t("examWeeks.slots.deleteLabel", { name: slot.subject.name })}
                  onClick={() => onAction({ kind: "delete", slot })}
                >
                  {t("examWeeks.common.delete")}
                </Button>
              </div>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

/** A clash in words, naming the exams, rooms, teacher or students it is about. */
export function clashText(clash: ExamClash, period: ExamPeriod, t: TFunction): string {
  const slots = new Map(period.slots.map((slot) => [slot.id, slot]));
  const rooms = new Map(period.slots.flatMap((slot) => slot.rooms.map((room) => [room.id, room])));
  const exams =
    clash.slot_ids
      .map((id) => slots.get(id))
      .map((slot) =>
        slot
          ? `${slot.subject.name} (${slot.grade_level.name}, ${slot.starts_at})`
          : t("examWeeks.clashes.otherPeriod"),
      )
      .join(" · ") || "—";
  const room = clash.room_ids.map((id) => rooms.get(id)?.name ?? "—").join(", ");
  return t(`examWeeks.clashes.types.${clash.type}`, {
    exams,
    room,
    teacher: clash.teacher?.name ?? "",
    students: clash.students.map((student) => student.name).join(", "),
    number: clash.count ?? 0,
    seat: clash.seat_number ?? 0,
    seated: clash.seated ?? 0,
    capacity: clash.capacity ?? 0,
    holiday: clash.holiday ?? "",
  });
}

function ClashesBlock({
  period,
  clashes,
  pending,
  error,
}: {
  period: ExamPeriod;
  clashes: readonly ExamClash[];
  pending: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  const errors = clashes.filter((clash) => clash.severity === "error").length;
  return (
    <section className="ag-block" aria-labelledby="ew-clashes-heading">
      <h2 id="ew-clashes-heading">{t("examWeeks.clashes.heading")}</h2>
      {pending ? (
        <p className="ag-muted" role="status">
          {t("examWeeks.loading")}
        </p>
      ) : error ? (
        <p className="ag-error" role="alert">
          {problemMessage(error, t)}
        </p>
      ) : clashes.length === 0 ? (
        <p className="ag-notice ag-notice--success">{t("examWeeks.clashes.none")}</p>
      ) : (
        <>
          <p className={errors > 0 ? "ag-notice" : "ag-muted"}>
            {t("examWeeks.clashes.summary", { errors, warnings: clashes.length - errors })}
          </p>
          <ul className="ew-clashes">
            {clashes.map((clash, index) => (
              <li key={`${clash.type}-${clash.slot_ids.join("-")}-${index}`}>
                <SeverityBadge severity={clash.severity} /> {clashText(clash, period, t)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface SlotDraft {
  subjectId: string | undefined;
  gradeLevelId: string | undefined;
  sectionIds: string[];
  examDate: string;
  startsAt: string;
  endsAt: string;
  assessmentId: string | undefined;
  notes: string;
  roomIds: string[];
}

function slotDraft(period: ExamPeriod, slot: ExamSlot | null): SlotDraft {
  return {
    subjectId: slot?.subject.id,
    gradeLevelId: slot?.grade_level.id ?? period.grade_levels[0]?.id,
    sectionIds: slot?.sections.map((section) => section.id) ?? [],
    examDate: slot?.exam_date ?? period.starts_on,
    startsAt: slot?.starts_at ?? "09:00",
    endsAt: slot?.ends_at ?? "11:00",
    assessmentId: slot?.assessment?.id,
    notes: slot?.notes ?? "",
    roomIds: slot?.rooms.map((room) => room.id) ?? [],
  };
}

export function slotBody(draft: SlotDraft): ExamSlotInput {
  return {
    subject_id: draft.subjectId!,
    grade_level_id: draft.gradeLevelId!,
    section_ids: draft.sectionIds,
    exam_date: draft.examDate,
    starts_at: draft.startsAt,
    ends_at: draft.endsAt,
    assessment_id: draft.assessmentId ?? null,
    notes: draft.notes.trim() || null,
    room_ids: draft.roomIds,
  };
}

function SlotFormModal({
  period,
  slot,
  onClose,
}: {
  period: ExamPeriod;
  slot: ExamSlot | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatNumber } = useFormatters();
  const subjects = useSubjects();
  const sections = useSections(period.academic_year_id);
  const rooms = useRooms();
  const save = useSaveExamSlot();
  const [draft, setDraft] = useState<SlotDraft>(() => slotDraft(period, slot));
  const [error, setError] = useState<string | null>(null);
  const assessments = useGradeAssessments(period.academic_year_id, draft.gradeLevelId);

  const gradeSections = (sections.data ?? []).filter(
    (section) => section.grade_level_id === draft.gradeLevelId,
  );
  const subjectAssessments =
    (draft.subjectId ? assessments.data?.get(draft.subjectId) : undefined) ?? [];
  const activeRooms = (rooms.data ?? []).filter(
    (room) => room.is_active || draft.roomIds.includes(room.id),
  );
  const timesInvalid =
    draft.endsAt !== "" && draft.startsAt !== "" && draft.endsAt <= draft.startsAt;
  const valid =
    draft.subjectId !== undefined &&
    draft.gradeLevelId !== undefined &&
    draft.sectionIds.length > 0 &&
    draft.examDate !== "" &&
    draft.startsAt !== "" &&
    draft.endsAt !== "" &&
    !timesInvalid;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setError(null);
    save.mutate(
      { periodId: period.id, slotId: slot?.id ?? null, body: slotBody(draft) },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("examWeeks.slots.saved") });
          onClose();
        },
        onError: (problem) => setError(problemMessage(problem, t)),
      },
    );
  };

  const toggleRoom = (roomId: string, on: boolean) =>
    setDraft({
      ...draft,
      roomIds: on ? [...draft.roomIds, roomId] : draft.roomIds.filter((id) => id !== roomId),
    });

  return (
    <Modal
      open
      onClose={onClose}
      title={slot ? t("examWeeks.slots.editTitle") : t("examWeeks.slots.addTitle")}
      size="wide"
    >
      <form className="ag-form" onSubmit={submit}>
        <Modal.Body>
          <div className="ag-form">
            <div className="ag-grid ag-grid--dense">
              <Select
                label={t("examWeeks.slots.fields.grade")}
                options={period.grade_levels.map((grade) => ({
                  value: grade.id,
                  label: grade.name,
                }))}
                value={draft.gradeLevelId}
                onChange={(gradeLevelId) =>
                  setDraft({ ...draft, gradeLevelId, sectionIds: [], assessmentId: undefined })
                }
              />
              <Select
                label={t("examWeeks.slots.fields.subject")}
                placeholder={t("examWeeks.slots.fields.subjectPlaceholder")}
                options={(subjects.data ?? []).map((subject) => ({
                  value: subject.id,
                  label: subject.name,
                }))}
                value={draft.subjectId}
                disabled={subjects.isPending}
                onChange={(subjectId) => setDraft({ ...draft, subjectId, assessmentId: undefined })}
              />
              <Input
                type="date"
                label={t("examWeeks.slots.fields.date")}
                value={draft.examDate}
                min={period.starts_on}
                max={period.ends_on}
                required
                onChange={(event) => setDraft({ ...draft, examDate: event.target.value })}
              />
              <Input
                type="time"
                label={t("examWeeks.slots.fields.startsAt")}
                value={draft.startsAt}
                required
                onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })}
              />
              <Input
                type="time"
                label={t("examWeeks.slots.fields.endsAt")}
                value={draft.endsAt}
                required
                error={timesInvalid ? t("examWeeks.slots.timesInvalid") : undefined}
                onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })}
              />
              <Select
                label={t("examWeeks.slots.fields.assessment")}
                options={[
                  { value: "", label: t("examWeeks.slots.fields.noAssessment") },
                  ...subjectAssessments.map((assessment) => ({
                    value: assessment.id,
                    label: assessment.name,
                  })),
                ]}
                value={draft.assessmentId ?? ""}
                disabled={subjectAssessments.length === 0}
                onChange={(assessmentId) =>
                  setDraft({ ...draft, assessmentId: assessmentId || undefined })
                }
              />
            </div>
            <fieldset className="ew-fieldset">
              <legend>{t("examWeeks.slots.fields.sections")}</legend>
              {gradeSections.length === 0 ? (
                <p className="ag-muted">{t("examWeeks.slots.fields.noSections")}</p>
              ) : (
                <div className="ag-checks">
                  {gradeSections.map((section) => (
                    <Checkbox
                      key={section.id}
                      label={section.name}
                      checked={draft.sectionIds.includes(section.id)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          sectionIds: event.target.checked
                            ? [...draft.sectionIds, section.id]
                            : draft.sectionIds.filter((id) => id !== section.id),
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </fieldset>
            <fieldset className="ew-fieldset">
              <legend>{t("examWeeks.slots.fields.rooms")}</legend>
              <p className="ag-muted">{t("examWeeks.slots.fields.roomsHelp")}</p>
              <div className="ag-checks ag-checks--scroll">
                {activeRooms.map((room) => {
                  const order = draft.roomIds.indexOf(room.id);
                  const seats = room.exam_capacity ?? room.capacity;
                  return (
                    <Checkbox
                      key={room.id}
                      label={`${order >= 0 ? `${formatNumber(order + 1)}. ` : ""}${room.name} (${
                        seats === null ? "—" : formatNumber(seats)
                      })`}
                      checked={order >= 0}
                      onChange={(event) => toggleRoom(room.id, event.target.checked)}
                    />
                  );
                })}
              </div>
            </fieldset>
            <Input
              label={t("examWeeks.slots.fields.notes")}
              value={draft.notes}
              maxLength={500}
              onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            />
            {error ? (
              <p className="ag-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("examWeeks.common.cancel")}
          </Button>
          <Button type="submit" disabled={!valid || save.isPending}>
            {t("examWeeks.slots.save")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

function InvigilatorsModal({ slot, onClose }: { slot: ExamSlot; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const teachers = useTeacherContacts();
  const save = useSetInvigilators();
  const [byRoom, setByRoom] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      slot.rooms.map((room) => [room.id, room.invigilators.map((teacher) => teacher.id)]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const sortedTeachers = useMemo(
    () => [...(teachers.data ?? [])].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [teachers.data],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    save.mutate(
      {
        slotId: slot.id,
        rooms: slot.rooms.map((room) => ({ room_id: room.id, teacher_ids: byRoom[room.id] ?? [] })),
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("examWeeks.invigilators.saved") });
          onClose();
        },
        onError: (problem) => setError(problemMessage(problem, t)),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("examWeeks.invigilators.title", { name: slot.subject.name })}
      description={t("examWeeks.invigilators.help")}
      size="wide"
    >
      <form className="ag-form" onSubmit={submit}>
        <Modal.Body>
          <div className="ag-form">
            {slot.rooms.map((room) => (
              <fieldset key={room.id} className="ew-fieldset">
                <legend>{room.name}</legend>
                <div className="ag-checks ag-checks--scroll">
                  {sortedTeachers.map((teacher) => (
                    <Checkbox
                      key={teacher.id}
                      label={teacher.display_name}
                      aria-label={t("examWeeks.invigilators.pick", {
                        teacher: teacher.display_name,
                        room: room.name,
                      })}
                      checked={(byRoom[room.id] ?? []).includes(teacher.id)}
                      onChange={(event) =>
                        setByRoom({
                          ...byRoom,
                          [room.id]: event.target.checked
                            ? [...(byRoom[room.id] ?? []), teacher.id]
                            : (byRoom[room.id] ?? []).filter((id) => id !== teacher.id),
                        })
                      }
                    />
                  ))}
                </div>
              </fieldset>
            ))}
            {error ? (
              <p className="ag-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("examWeeks.common.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {t("examWeeks.invigilators.save")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
