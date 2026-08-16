import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";

import { useUnlinkGuardian } from "./mutations";
import { RELATIONSHIP_LABELS } from "./schema";

import type { GuardianContact } from "./queries";

export interface UnlinkGuardianDialogProps {
  studentId: string;
  guardian: GuardianContact | null;
  onClose: () => void;
}

/** Confirms before `DELETE /api/students/{studentId}/guardians/{userId}` — irreversible from this
 * screen; re-linking afterward is a fresh `POST`, not an undo. */
export function UnlinkGuardianDialog({ studentId, guardian, onClose }: UnlinkGuardianDialogProps) {
  const { show } = useToast();
  const unlinkGuardian = useUnlinkGuardian();
  const open = guardian !== null;

  function handleConfirm() {
    if (!guardian) return;
    const label = guardian.user?.display_name ?? guardian.user?.email ?? "guardian";
    unlinkGuardian.mutate(
      { studentId, userId: guardian.parent_user_id },
      {
        onSuccess: () => {
          show({ variant: "success", title: `Removed ${label}` });
          onClose();
        },
        onError: (error) => {
          show({
            variant: "error",
            title: "Couldn't remove guardian",
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Remove guardian"
      description={
        guardian
          ? `${guardian.user?.display_name ?? guardian.user?.email ?? guardian.parent_user_id} — ${RELATIONSHIP_LABELS[guardian.relationship]}`
          : undefined
      }
    >
      <Modal.Body>
        <p>
          This removes the parent-child link. The guardian will no longer see this student's
          records.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={unlinkGuardian.isPending}
          onClick={handleConfirm}
        >
          Remove
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
