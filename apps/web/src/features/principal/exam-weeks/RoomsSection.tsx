import { Button, Checkbox, Input, Modal, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { Badge } from "../academic-setup/components";
import { problemMessage } from "../academic-setup/errors";

import { useRooms, useSaveRoom } from "./queries";

import type { Room } from "./queries";
import type { FormEvent } from "react";

/**
 * The school's rooms with their everyday and exam capacity (how many candidates sit an exam there,
 * spaced). Rooms are deactivated, never deleted: timetables and exam seats keep pointing at them.
 */
export function RoomsSection() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const rooms = useRooms();
  const [editing, setEditing] = useState<{ room: Room | null } | null>(null);

  return (
    <section className="ag-block" aria-labelledby="ew-rooms-heading">
      <div className="ag-head">
        <h2 id="ew-rooms-heading">{t("examWeeks.rooms.heading")}</h2>
        <Button type="button" variant="secondary" onClick={() => setEditing({ room: null })}>
          {t("examWeeks.rooms.add")}
        </Button>
      </div>
      <p className="ag-muted">{t("examWeeks.rooms.help")}</p>
      <Table caption={t("examWeeks.rooms.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("examWeeks.rooms.columns.room")}</Table.HeaderCell>
            <Table.HeaderCell>{t("examWeeks.rooms.columns.building")}</Table.HeaderCell>
            <Table.HeaderCell>{t("examWeeks.rooms.columns.capacity")}</Table.HeaderCell>
            <Table.HeaderCell>{t("examWeeks.rooms.columns.examCapacity")}</Table.HeaderCell>
            <Table.HeaderCell>{t("examWeeks.rooms.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={5}
          loading={rooms.isPending}
          empty={rooms.isError ? problemMessage(rooms.error, t) : t("examWeeks.rooms.empty")}
        >
          {(rooms.data ?? []).map((room) => (
            <Table.Row key={room.id}>
              <Table.Cell>
                <strong>{room.name}</strong> <span className="ag-muted">{room.code}</span>{" "}
                {room.is_active ? null : (
                  <Badge tone="neutral">{t("examWeeks.rooms.inactive")}</Badge>
                )}
              </Table.Cell>
              <Table.Cell>
                {[
                  room.building,
                  room.floor ? t("examWeeks.rooms.floor", { floor: room.floor }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </Table.Cell>
              <Table.Cell>{room.capacity === null ? "—" : formatNumber(room.capacity)}</Table.Cell>
              <Table.Cell>
                {room.exam_capacity === null
                  ? t("examWeeks.rooms.sameAsCapacity")
                  : formatNumber(room.exam_capacity)}
              </Table.Cell>
              <Table.Cell>
                {room.room_type === "physical" ? (
                  <Button
                    type="button"
                    variant="tertiary"
                    aria-label={t("examWeeks.rooms.editLabel", { name: room.name })}
                    onClick={() => setEditing({ room })}
                  >
                    {t("examWeeks.common.edit")}
                  </Button>
                ) : null}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {editing ? <RoomFormModal room={editing.room} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value));
const positiveOrBlank = (value: string) =>
  value.trim() === "" || (Number.isInteger(Number(value)) && Number(value) > 0);

function RoomFormModal({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const save = useSaveRoom();
  const [code, setCode] = useState(room?.code ?? "");
  const [name, setName] = useState(room?.name ?? "");
  const [building, setBuilding] = useState(room?.building ?? "");
  const [floor, setFloor] = useState(room?.floor ?? "");
  const [capacity, setCapacity] = useState(room?.capacity?.toString() ?? "");
  const [examCapacity, setExamCapacity] = useState(room?.exam_capacity?.toString() ?? "");
  const [active, setActive] = useState(room?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);

  const valid =
    code.trim() !== "" &&
    name.trim() !== "" &&
    building.trim() !== "" &&
    positiveOrBlank(capacity) &&
    positiveOrBlank(examCapacity);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setError(null);
    const shared = {
      name: name.trim(),
      building: building.trim(),
      floor: floor.trim() || null,
      capacity: numberOrNull(capacity),
      exam_capacity: numberOrNull(examCapacity),
    };
    save.mutate(
      room
        ? { roomId: room.id, body: { ...shared, is_active: active } }
        : { roomId: null, body: { ...shared, code: code.trim() } },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("examWeeks.rooms.saved") });
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
      title={room ? t("examWeeks.rooms.editTitle") : t("examWeeks.rooms.addTitle")}
    >
      <form className="ag-form" onSubmit={submit}>
        <Modal.Body>
          <div className="ag-form">
            <Input
              label={t("examWeeks.rooms.fields.code")}
              value={code}
              required
              maxLength={40}
              disabled={room !== null}
              onChange={(event) => setCode(event.target.value)}
            />
            <Input
              label={t("examWeeks.rooms.fields.name")}
              value={name}
              required
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="ag-grid ag-grid--dense">
              <Input
                label={t("examWeeks.rooms.fields.building")}
                value={building}
                required
                maxLength={120}
                onChange={(event) => setBuilding(event.target.value)}
              />
              <Input
                label={t("examWeeks.rooms.fields.floor")}
                value={floor}
                maxLength={40}
                onChange={(event) => setFloor(event.target.value)}
              />
              <Input
                type="number"
                min={1}
                label={t("examWeeks.rooms.fields.capacity")}
                value={capacity}
                onChange={(event) => setCapacity(event.target.value)}
              />
              <Input
                type="number"
                min={1}
                label={t("examWeeks.rooms.fields.examCapacity")}
                helperText={t("examWeeks.rooms.fields.examCapacityHelp")}
                value={examCapacity}
                onChange={(event) => setExamCapacity(event.target.value)}
              />
            </div>
            {room ? (
              <Checkbox
                label={t("examWeeks.rooms.fields.active")}
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
              />
            ) : null}
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
            {t("examWeeks.rooms.save")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
