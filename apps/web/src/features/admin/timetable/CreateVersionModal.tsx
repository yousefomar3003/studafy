import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateVersion } from "./mutations";

import type { TimetableVersion } from "./queries";
import type { FormEvent } from "react";

export interface CreateVersionModalProps {
  open: boolean;
  onClose: () => void;
  termId: string;
  academicYearId: string;
  onCreated: (version: TimetableVersion) => void;
}

/** `POST /api/academics/timetable-versions` — always creates a fresh `draft`; there is no path to
 * create a version already `pending`/`approved` (see the DB's `enforce_timetable_version_transition`
 * trigger, `docs/database/timetable-model.md`). */
export function CreateVersionModal({
  open,
  onClose,
  termId,
  academicYearId,
  onCreated,
}: CreateVersionModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createVersion = useCreateVersion();

  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  function reset() {
    setName("");
    setError(undefined);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("adminSchool.timetable.createModal.nameRequired"));
      return;
    }

    createVersion.mutate(
      { term_id: termId, academic_year_id: academicYearId, name: trimmed },
      {
        onSuccess: (version) => {
          show({
            variant: "success",
            title: t("adminSchool.timetable.toast.created", { name: version.name }),
          });
          onCreated(version);
          handleClose();
        },
        onError: (err) => {
          show({
            variant: "error",
            title: t("adminSchool.timetable.toast.createFailed"),
            description: err instanceof ApiError ? (err.detail ?? err.title) : undefined,
          });
        },
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("adminSchool.timetable.createModal.title")}
      description={t("adminSchool.timetable.createModal.description")}
    >
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label={t("adminSchool.timetable.createModal.title")}
      >
        <Modal.Body>
          <Input
            label={t("adminSchool.timetable.createModal.name")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(undefined);
            }}
            error={error}
            required
            autoFocus
            placeholder={t("adminSchool.timetable.createModal.namePlaceholder")}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            {t("adminSchool.timetable.createModal.cancel")}
          </Button>
          <Button type="submit" loading={createVersion.isPending}>
            {t("adminSchool.timetable.createModal.create")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
