import { Button, Checkbox, Input, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { problemMessage } from "../academic-setup/errors";

import {
  SEATING_STRATEGIES,
  useExamPeriodSeating,
  useGenerateSeating,
  useMoveSeat,
} from "./queries";

import type { ExamPeriod, ExamSeat, ExamSlot, SeatingStrategy } from "./queries";

/**
 * One exam's seating: generate it (by section, alphabetically or with sections interleaved,
 * keeping seats already given unless told otherwise), see who sits where and who is left without a
 * seat, and move a student by hand (a swap when the seat is taken in this exam).
 */
export function SeatingModal({
  period,
  slot,
  onClose,
}: {
  period: ExamPeriod;
  slot: ExamSlot;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatNumber } = useFormatters();
  const seating = useExamPeriodSeating(period.id);
  const generate = useGenerateSeating();
  const [strategy, setStrategy] = useState<SeatingStrategy>("by_section");
  const [keepExisting, setKeepExisting] = useState(true);
  const [moving, setMoving] = useState<ExamSeat | null>(null);
  const entry = seating.data?.slots.find((candidate) => candidate.slot_id === slot.id);
  const roomName = new Map(slot.rooms.map((room) => [room.id, room.name]));

  const run = () =>
    generate.mutate(
      { slotId: slot.id, strategy, keepExisting },
      {
        onSuccess: (result) =>
          show({
            variant: result.unseated.length > 0 ? "warning" : "success",
            title: t("examWeeks.seating.generated", {
              seated: formatNumber(result.seats.length),
              unseated: formatNumber(result.unseated.length),
            }),
          }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("examWeeks.seating.generateFailed"),
            description: problemMessage(error, t),
          }),
      },
    );

  return (
    <Modal
      open
      onClose={onClose}
      title={t("examWeeks.seating.title", {
        name: `${slot.subject.name} (${slot.grade_level.name})`,
      })}
      size="wide"
    >
      <Modal.Body>
        <div className="ag-form">
          <div className="ag-grid ag-grid--dense">
            <Select
              label={t("examWeeks.seating.strategy")}
              options={SEATING_STRATEGIES.map((value) => ({
                value,
                label: t(`examWeeks.seating.strategies.${value}`),
              }))}
              value={strategy}
              onChange={setStrategy}
            />
          </div>
          <p className="ag-muted">{t(`examWeeks.seating.strategyHelp.${strategy}`)}</p>
          <Checkbox
            label={t("examWeeks.seating.keepExisting")}
            checked={keepExisting}
            onChange={(event) => setKeepExisting(event.target.checked)}
          />
          <div className="ag-row__actions">
            <Button type="button" disabled={generate.isPending} onClick={run}>
              {t("examWeeks.seating.generate")}
            </Button>
          </div>
          {seating.isPending ? (
            <p className="ag-muted" role="status">
              {t("examWeeks.loading")}
            </p>
          ) : seating.isError ? (
            <p className="ag-error" role="alert">
              {problemMessage(seating.error, t)}
            </p>
          ) : (
            <>
              <Table caption={t("examWeeks.seating.caption")} hideCaption>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t("examWeeks.seating.columns.room")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("examWeeks.seating.columns.seat")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("examWeeks.seating.columns.student")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("examWeeks.seating.columns.section")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("examWeeks.seating.columns.actions")}</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body columnCount={5} empty={t("examWeeks.seating.empty")}>
                  {(entry?.seats ?? []).map((seat) => (
                    <Table.Row key={seat.student_id}>
                      <Table.Cell>{roomName.get(seat.room_id) ?? "—"}</Table.Cell>
                      <Table.Cell>{formatNumber(seat.seat_number)}</Table.Cell>
                      <Table.Cell>
                        {seat.first_name} {seat.last_name}{" "}
                        <span className="ag-muted">{seat.admission_number}</span>
                      </Table.Cell>
                      <Table.Cell>{seat.section.name}</Table.Cell>
                      <Table.Cell>
                        <Button
                          type="button"
                          variant="tertiary"
                          aria-label={t("examWeeks.seating.moveLabel", {
                            name: `${seat.first_name} ${seat.last_name}`,
                          })}
                          onClick={() => setMoving(seat)}
                        >
                          {t("examWeeks.seating.move")}
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
              {(entry?.unseated ?? []).length > 0 ? (
                <div className="ag-notice" role="note">
                  <p>
                    {t("examWeeks.seating.unseated", {
                      number: formatNumber(entry!.unseated.length),
                    })}
                  </p>
                  <p>
                    {entry!.unseated
                      .map((student) => `${student.first_name} ${student.last_name}`)
                      .join(", ")}
                  </p>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("examWeeks.common.close")}
        </Button>
      </Modal.Footer>
      {moving ? <MoveSeatModal slot={slot} seat={moving} onClose={() => setMoving(null)} /> : null}
    </Modal>
  );
}

function MoveSeatModal({
  slot,
  seat,
  onClose,
}: {
  slot: ExamSlot;
  seat: ExamSeat;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const move = useMoveSeat();
  const [roomId, setRoomId] = useState(seat.room_id);
  const [seatNumber, setSeatNumber] = useState(String(seat.seat_number));
  const [error, setError] = useState<string | null>(null);
  const valid = Number.isInteger(Number(seatNumber)) && Number(seatNumber) > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={t("examWeeks.seating.moveTitle", { name: `${seat.first_name} ${seat.last_name}` })}
      description={t("examWeeks.seating.moveHelp")}
    >
      <form
        className="ag-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          setError(null);
          move.mutate(
            {
              slotId: slot.id,
              studentId: seat.student_id,
              roomId,
              seatNumber: Number(seatNumber),
            },
            {
              onSuccess: () => {
                show({ variant: "success", title: t("examWeeks.seating.moved") });
                onClose();
              },
              onError: (problem) => setError(problemMessage(problem, t)),
            },
          );
        }}
      >
        <Modal.Body>
          <div className="ag-form">
            <Select
              label={t("examWeeks.seating.columns.room")}
              options={slot.rooms.map((room) => ({ value: room.id, label: room.name }))}
              value={roomId}
              onChange={setRoomId}
            />
            <Input
              type="number"
              min={1}
              label={t("examWeeks.seating.columns.seat")}
              value={seatNumber}
              required
              onChange={(event) => setSeatNumber(event.target.value)}
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
          <Button type="submit" disabled={!valid || move.isPending}>
            {t("examWeeks.seating.moveSave")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
