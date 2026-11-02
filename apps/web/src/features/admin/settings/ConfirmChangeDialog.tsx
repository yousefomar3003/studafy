import { Button, Modal } from "@studafy/ui";

import { useTranslation } from "../../../lib/i18n";

import type { ReactNode } from "react";

export interface ConfirmChangeDialogProps {
  open: boolean;
  title: string;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
  confirmLabel?: string;
  children: ReactNode;
}

/**
 * Confirms before a save that takes effect school-wide and retroactively — a grading scheme change
 * re-labels every existing grade, a discipline-visibility flip changes what every parent can already
 * see. Same Modal-confirm shape as `RevokeInvitationDialog`/`DeactivateUserDialog`, reused here since
 * more than one settings section needs it.
 */
export function ConfirmChangeDialog({
  open,
  title,
  loading,
  onConfirm,
  onClose,
  confirmLabel,
  children,
}: ConfirmChangeDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <Modal.Body>{children}</Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("adminSchool.settings.confirm.cancel")}
        </Button>
        <Button type="button" variant="primary" loading={loading} onClick={onConfirm}>
          {confirmLabel ?? t("adminSchool.settings.confirm.saveAnyway")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
