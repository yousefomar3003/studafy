import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useEffect, useId, useState } from "react";

import { useResolveIncident } from "./mutations";

export interface ResolveIncidentModalProps {
  open: boolean;
  incidentId: string;
  onClose: () => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * Confirms resolution with optional resolution notes. Only ever opened once the detail screen has
 * confirmed the incident already has at least one recorded action — this modal itself doesn't
 * re-check that, it just carries out the resolve call the caller already gated.
 */
export function ResolveIncidentModal({ open, incidentId, onClose }: ResolveIncidentModalProps) {
  const { show } = useToast();
  const [resolutionDescription, setResolutionDescription] = useState("");
  const resolve = useResolveIncident(incidentId);
  const notesId = useId();

  useEffect(() => {
    if (!open) return;
    setResolutionDescription("");
  }, [open]);

  function handleSubmit() {
    resolve.mutate(
      { resolution_description: resolutionDescription.trim() || undefined },
      {
        onSuccess: () => {
          show({ variant: "success", title: "Incident resolved" });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: "Couldn't resolve incident",
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Resolve incident"
      description="Marks the incident resolved. If this school allows parent visibility, it becomes visible to the student's parent."
    >
      <Modal.Body>
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={notesId}>
            Resolution notes
          </label>
          <div className="sf-input discipline-resolution-input">
            <textarea
              id={notesId}
              className="sf-input__control"
              rows={3}
              value={resolutionDescription}
              onChange={(event) => setResolutionDescription(event.target.value)}
            />
          </div>
        </div>
        {resolve.isError ? (
          <p role="alert" className="discipline-detail__hint">
            {apiErrorDescription(resolve.error) ?? "The incident could not be resolved."}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="primary" loading={resolve.isPending} onClick={handleSubmit}>
          Resolve
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
