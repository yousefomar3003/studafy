import { Button, Modal } from "@studafy/ui";

import type { ReactNode } from "react";

export interface AdjustmentConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  loading: boolean;
  confirmLabel: string;
  /** Surfaced inline rather than as a toast so the dialog stays open with the computed effect still
   * visible — the user can see exactly what they were about to commit while deciding whether to
   * retry or cancel. */
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Maker-checker confirmation shared by both the scholarship award and refund flows: it always shows
 * the exact computed financial effect (as `children`, a `<dl>` built by the caller) before either
 * step commits. Same Modal-confirm shape as `admin/settings/ConfirmChangeDialog`, generalized with
 * an inline error slot since a commit here calls ERPNext and can fail after the dialog opens (see
 * `principal/discipline/ResolveIncidentModal`'s `resolve.isError` for the same in-dialog-error idiom).
 */
export function AdjustmentConfirmDialog({
  open,
  title,
  description,
  loading,
  confirmLabel,
  error,
  onConfirm,
  onClose,
  children,
}: AdjustmentConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description}>
      <Modal.Body>
        {children}
        {error ? (
          <p role="alert" className="adjustments-confirm__error">
            {error}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="primary" loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
