import { Button, Modal } from "@studafy/ui";
import { useId, useState } from "react";

import type { FormEvent } from "react";

export interface RejectReasonModalProps {
  open: boolean;
  /** Defaults to "Reject item" — the bulk toolbar passes "Reject selected items" instead. */
  title?: string;
  description?: string;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/**
 * Reason-required reject confirmation. One reason applies to every target — the row action passes
 * a single item, the bulk toolbar's "Reject selected" passes the whole selection (see
 * `ApprovalQueuePage.tsx`) — so the API's hard requirement for grade-submission rejections
 * (`decideSubmission` in `apps/api/src/modules/grades/grade-entry-service.ts`) is enforced client
 * side for both item types and both entry counts, rather than only the one the server already
 * guards.
 *
 * The caller should remount this component (e.g. `key={target?.id ?? "bulk:" + ids.join(",")}`)
 * when switching between targets, so leftover text from a previous reject never bleeds into the
 * next one.
 */
export function RejectReasonModal({
  open,
  title = "Reject item",
  description,
  submitting,
  onCancel,
  onConfirm,
}: RejectReasonModalProps) {
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const reasonId = useId();
  const errorId = `${reasonId}-error`;
  const trimmedReason = reason.trim();
  const invalid = touched && trimmedReason === "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (trimmedReason === "") return;
    onConfirm(trimmedReason);
  }

  return (
    <Modal open={open} onClose={onCancel} title={title} description={description}>
      <form onSubmit={handleSubmit} noValidate>
        <Modal.Body>
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={reasonId}>
              Reason
              <span className="sf-field__required" aria-hidden="true">
                *
              </span>
            </label>
            <div className="sf-input approvals-reason-input">
              <textarea
                id={reasonId}
                className="sf-input__control"
                rows={3}
                required
                autoFocus
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-invalid={invalid ? true : undefined}
                aria-describedby={invalid ? errorId : undefined}
              />
            </div>
            {invalid ? (
              <p className="sf-field__error" id={errorId} role="alert">
                A reason is required to reject.
              </p>
            ) : null}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={submitting}>
            Reject
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
