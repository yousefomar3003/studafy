import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";

import { useTranslation } from "../../../lib/i18n";

import { useRevokeInvitation } from "./mutations";

import type { InvitationWithStatus } from "./queries";

export interface RevokeInvitationDialogProps {
  invitation: InvitationWithStatus | null;
  onClose: () => void;
}

/**
 * Confirms before `POST /api/invitations/{id}/revoke`, which immediately invalidates the invite
 * link — irreversible from this screen, same as `DeactivateUserDialog` for users.
 */
export function RevokeInvitationDialog({ invitation, onClose }: RevokeInvitationDialogProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const revokeInvitation = useRevokeInvitation();

  function handleConfirm() {
    if (!invitation) return;
    revokeInvitation.mutate(invitation.id, {
      onSuccess: () => {
        show({
          variant: "success",
          title: t("adminPeople.invitations.revoke.successToast", { email: invitation.email }),
        });
        onClose();
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminPeople.invitations.revoke.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={invitation !== null}
      onClose={onClose}
      title={t("adminPeople.invitations.revoke.title")}
      description={invitation?.email}
    >
      <Modal.Body>
        <p>{t("adminPeople.invitations.revoke.body")}</p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("adminPeople.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={revokeInvitation.isPending}
          onClick={handleConfirm}
        >
          {t("adminPeople.invitations.revoke.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
