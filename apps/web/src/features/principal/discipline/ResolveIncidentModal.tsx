import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useEffect, useId, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

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
  const { t } = useTranslation();
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
          show({ variant: "success", title: t("principal.discipline.resolve.success") });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("principal.discipline.resolve.failed"),
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("principal.discipline.resolve.title")}
      description={t("principal.discipline.resolve.description")}
    >
      <Modal.Body>
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={notesId}>
            {t("principal.discipline.resolve.notes")}
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
            {apiErrorDescription(resolve.error) ?? t("principal.discipline.resolve.errorFallback")}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button type="button" variant="primary" loading={resolve.isPending} onClick={handleSubmit}>
          {t("principal.discipline.resolve.submit")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
