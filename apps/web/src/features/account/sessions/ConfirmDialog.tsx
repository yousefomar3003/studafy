import { Button, Modal } from "@studafy/ui";

import { useTranslation } from "../../../lib/i18n";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Destructive-action confirmation for the sessions screen — the account analogue of
 * `features/admin/users/DeactivateUserDialog.tsx`: a modal holding only the consequence statement
 * and Cancel/Confirm. Every revoke action that ends more than one session routes through here, so
 * the irreversible step is always an explicit second click.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <Modal.Body>
        <p>{body}</p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onCancel}>
          {t("deviceSessions.cancel")}
        </Button>
        <Button type="button" loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
