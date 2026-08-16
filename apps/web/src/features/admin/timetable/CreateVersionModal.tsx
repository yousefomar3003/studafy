import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

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
      setError("Name is required");
      return;
    }

    createVersion.mutate(
      { term_id: termId, academic_year_id: academicYearId, name: trimmed },
      {
        onSuccess: (version) => {
          show({ variant: "success", title: `Created draft "${version.name}"` });
          onCreated(version);
          handleClose();
        },
        onError: (err) => {
          show({
            variant: "error",
            title: "Couldn't create draft",
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
      title="New draft timetable"
      description="Start a new draft version for this term."
    >
      <form onSubmit={handleSubmit} noValidate aria-label="New draft timetable">
        <Modal.Body>
          <Input
            label="Draft name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(undefined);
            }}
            error={error}
            required
            autoFocus
            placeholder="Term 1 Weekly Schedule"
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={createVersion.isPending}>
            Create draft
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
