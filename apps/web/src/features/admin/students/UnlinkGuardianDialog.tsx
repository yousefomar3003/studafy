import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";

import { useTranslation } from "../../../lib/i18n";

import { useUnlinkGuardian } from "./mutations";
import { RELATIONSHIP_LABEL_KEYS } from "./schema";

import type { GuardianContact } from "./queries";

export interface UnlinkGuardianDialogProps {
  studentId: string;
  guardian: GuardianContact | null;
  onClose: () => void;
}

/** Confirms before `DELETE /api/students/{studentId}/guardians/{userId}` — irreversible from this
 * screen; re-linking afterward is a fresh `POST`, not an undo. */
export function UnlinkGuardianDialog({ studentId, guardian, onClose }: UnlinkGuardianDialogProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const unlinkGuardian = useUnlinkGuardian();
  const open = guardian !== null;

  function handleConfirm() {
    if (!guardian) return;
    const label =
      guardian.user?.display_name ??
      guardian.user?.email ??
      t("adminPeople.students.unlinkGuardian.guardianFallback");
    unlinkGuardian.mutate(
      { studentId, userId: guardian.parent_user_id },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("adminPeople.students.unlinkGuardian.removedToast", { name: label }),
          });
          onClose();
        },
        onError: (error) => {
          show({
            variant: "error",
            title: t("adminPeople.students.unlinkGuardian.error"),
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
      title={t("adminPeople.students.unlinkGuardian.title")}
      description={
        guardian
          ? t("adminPeople.students.unlinkGuardian.description", {
              name: guardian.user?.display_name ?? guardian.user?.email ?? guardian.parent_user_id,
              relationship: t(RELATIONSHIP_LABEL_KEYS[guardian.relationship]),
            })
          : undefined
      }
    >
      <Modal.Body>
        <p>{t("adminPeople.students.unlinkGuardian.body")}</p>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("adminPeople.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={unlinkGuardian.isPending}
          onClick={handleConfirm}
        >
          {t("adminPeople.students.unlinkGuardian.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
