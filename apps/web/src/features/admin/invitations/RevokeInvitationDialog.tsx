import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";

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
  const { show } = useToast();
  const revokeInvitation = useRevokeInvitation();

  function handleConfirm() {
    if (!invitation) return;
    revokeInvitation.mutate(invitation.id, {
      onSuccess: () => {
        show({ variant: "success", title: `Invitation to ${invitation.email} revoked` });
        onClose();
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't revoke invitation",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={invitation !== null}
      onClose={onClose}
      title="Revoke invitation"
      description={invitation?.email}
    >
      <Modal.Body>
        <p>
          The invite link stops working immediately. This cannot be undone from this screen — send a
          new invitation if they still need access.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={revokeInvitation.isPending}
          onClick={handleConfirm}
        >
          Revoke
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
