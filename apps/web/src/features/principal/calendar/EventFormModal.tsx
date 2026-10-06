import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import {
  SCHOOL_EVENT_KINDS,
  useCreateSchoolEvent,
  useDeleteSchoolEvent,
  useUpdateSchoolEvent,
} from "../school/queries";

import type { SchoolEvent, SchoolEventKind } from "../school/queries";

export interface EventFormModalProps {
  open: boolean;
  onClose: () => void;
  /** The event being edited; omitted when adding a new one. */
  event?: SchoolEvent;
  /** Pre-filled start (and end) date for a new event, e.g. the day the user clicked. */
  defaultDate: string;
}

/**
 * Add or edit one school calendar entry (holiday, event, meeting, exam period). Editing also offers
 * removal. Mounted fresh for each open (keyed by the caller), so its fields start from `event` or
 * `defaultDate` without an effect to reset them.
 */
export function EventFormModal({ open, onClose, event, defaultDate }: EventFormModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateSchoolEvent();
  const update = useUpdateSchoolEvent();
  const remove = useDeleteSchoolEvent();

  const [title, setTitle] = useState(event?.title ?? "");
  const [kind, setKind] = useState<SchoolEventKind>(event?.kind ?? "event");
  const [startsOn, setStartsOn] = useState(event?.starts_on ?? defaultDate);
  const [endsOn, setEndsOn] = useState(event?.ends_on ?? defaultDate);
  const [description, setDescription] = useState(event?.description ?? "");
  const [error, setError] = useState<string>();

  const busy = create.isPending || update.isPending || remove.isPending;

  function validate(): string | undefined {
    if (title.trim() === "") return t("principal.calendar.form.titleRequired");
    if (startsOn === "" || endsOn === "") return t("principal.calendar.form.datesRequired");
    if (endsOn < startsOn) return t("principal.calendar.form.endBeforeStart");
    return undefined;
  }

  function handleSave() {
    const problem = validate();
    setError(problem);
    if (problem) return;
    const body = {
      title: title.trim(),
      kind,
      starts_on: startsOn,
      ends_on: endsOn,
      description: description.trim() === "" ? null : description.trim(),
    };
    const done = {
      onSuccess: () => {
        show({ variant: "success", title: t("principal.calendar.form.saved") });
        onClose();
      },
      onError: () => setError(t("principal.calendar.form.saveFailed")),
    };
    if (event) update.mutate({ id: event.id, body }, done);
    else create.mutate(body, done);
  }

  function handleDelete() {
    if (!event) return;
    remove.mutate(event.id, {
      onSuccess: () => {
        show({ variant: "success", title: t("principal.calendar.form.removed") });
        onClose();
      },
      onError: () => setError(t("principal.calendar.form.removeFailed")),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={event ? t("principal.calendar.form.editTitle") : t("principal.calendar.form.addTitle")}
    >
      <Modal.Body>
        <div className="principal-calendar__form">
          <Input
            label={t("principal.calendar.form.title")}
            value={title}
            maxLength={200}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
          <Select
            label={t("principal.calendar.form.kind")}
            options={SCHOOL_EVENT_KINDS.map((value) => ({
              value,
              label: t(`principal.calendar.kinds.${value}`),
            }))}
            value={kind}
            onChange={setKind}
          />
          <Input
            label={t("principal.calendar.form.startsOn")}
            type="date"
            value={startsOn}
            required
            onChange={(e) => setStartsOn(e.target.value)}
          />
          <Input
            label={t("principal.calendar.form.endsOn")}
            type="date"
            value={endsOn}
            min={startsOn}
            required
            onChange={(e) => setEndsOn(e.target.value)}
          />
          <Input
            label={t("principal.calendar.form.description")}
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
          />
          {error ? (
            <p role="alert" className="principal-calendar__form-error">
              {error}
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        {event ? (
          <Button type="button" variant="secondary" disabled={busy} onClick={handleDelete}>
            {t("principal.calendar.form.remove")}
          </Button>
        ) : null}
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.calendar.form.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={create.isPending || update.isPending}
          onClick={handleSave}
        >
          {t("principal.calendar.form.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
