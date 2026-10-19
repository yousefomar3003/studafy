import { Button, Modal } from "@studafy/ui";
import { useEffect, useId, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { RESOLUTION_NOTE_MAX_LENGTH } from "./labels";

export type ResolutionTarget = "actioned" | "dismissed";

export interface ResolveReportModalProps {
  /** Which closing status the modal confirms, or null when closed. */
  target: ResolutionTarget | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (target: ResolutionTarget, note: string) => void;
}

const TITLE_KEYS: Record<ResolutionTarget, string> = {
  actioned: "principal.messageReports.resolve.actionedTitle",
  dismissed: "principal.messageReports.resolve.dismissedTitle",
};

const SUBMIT_KEYS: Record<ResolutionTarget, string> = {
  actioned: "principal.messageReports.resolve.actionedSubmit",
  dismissed: "principal.messageReports.resolve.dismissedSubmit",
};

/**
 * Collects the resolution note that closing a report requires (1–2000 characters, enforced by the
 * API as well). The note is validated here on submit so an empty note never reaches the server;
 * the PATCH itself is owned by the detail page so it can handle the 409 race in one place.
 */
export function ResolveReportModal({
  target,
  submitting,
  onClose,
  onSubmit,
}: ResolveReportModalProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [showError, setShowError] = useState(false);
  const noteId = useId();
  const errorId = useId();

  useEffect(() => {
    if (target === null) return;
    setNote("");
    setShowError(false);
  }, [target]);

  const trimmed = note.trim();
  const invalid = trimmed.length === 0 || trimmed.length > RESOLUTION_NOTE_MAX_LENGTH;

  function handleSubmit() {
    if (target === null) return;
    if (invalid) {
      setShowError(true);
      return;
    }
    onSubmit(target, trimmed);
  }

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      // eslint-disable-next-line security/detect-object-injection -- `target` is a closed union of constant map keys
      title={target ? t(TITLE_KEYS[target]) : ""}
      description={t("principal.messageReports.resolve.description")}
    >
      <Modal.Body>
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={noteId}>
            {t("principal.messageReports.resolve.note")}
          </label>
          <div className="sf-input message-reports__note-input">
            <textarea
              id={noteId}
              className="sf-input__control"
              rows={4}
              required
              maxLength={RESOLUTION_NOTE_MAX_LENGTH}
              aria-invalid={showError && invalid ? true : undefined}
              aria-describedby={showError && invalid ? errorId : undefined}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
        {showError && invalid ? (
          <p id={errorId} role="alert" className="message-reports__error">
            {t("principal.messageReports.resolve.noteRequired")}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button type="button" variant="primary" loading={submitting} onClick={handleSubmit}>
          {/* eslint-disable-next-line security/detect-object-injection -- `target` is a closed union of constant map keys */}
          {target ? t(SUBMIT_KEYS[target]) : ""}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
