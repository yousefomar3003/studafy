import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { ChildrenPicker } from "../../admin/people-links/LinkPickers";

import { useLinkChildren } from "./queries";

import type { UnlinkedParent } from "./queries";
import type { ChildDraft } from "../../admin/people-links/LinkPickers";

export interface LinkChildrenModalProps {
  parent: UnlinkedParent | null;
  onClose: () => void;
}

/** Links a parent with no children to the students staff pick, from the unlinked list. */
export function LinkChildrenModal({ parent, onClose }: LinkChildrenModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const linkChildren = useLinkChildren();
  const [children, setChildren] = useState<ChildDraft[]>([]);

  function handleClose() {
    setChildren([]);
    onClose();
  }

  function submit() {
    if (!parent || children.length === 0) return;
    linkChildren.mutate(
      {
        parentUserId: parent.user_id,
        children: children.map((draft) => ({
          studentId: draft.student.id,
          relationship: draft.relationship,
        })),
      },
      {
        onSuccess: ({ linked }) => {
          show({
            variant: "success",
            title: t("finance.unlinked.linkChildren.linkedToast", {
              count: linked,
              name: parent.name,
            }),
          });
          handleClose();
        },
        onError: (error) => {
          const linked = (error as { linked?: number }).linked ?? 0;
          show({
            variant: "error",
            title: t("finance.unlinked.linkChildren.error"),
            description: [
              linked > 0 ? t("finance.unlinked.linkChildren.partial", { count: linked }) : null,
              error instanceof ApiError ? (error.detail ?? error.title) : null,
            ]
              .filter(Boolean)
              .join(" "),
          });
          if (linked > 0) handleClose();
        },
      },
    );
  }

  return (
    <Modal
      open={parent !== null}
      onClose={handleClose}
      title={t("finance.unlinked.linkChildren.title", { name: parent?.name ?? "" })}
      description={t("finance.unlinked.linkChildren.description")}
    >
      <Modal.Body>
        <ChildrenPicker
          value={children}
          onChange={setChildren}
          legend={t("finance.unlinked.linkChildren.legend")}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={handleClose}>
          {t("finance.common.cancel")}
        </Button>
        <Button
          type="button"
          loading={linkChildren.isPending}
          disabled={children.length === 0}
          onClick={submit}
        >
          {t("finance.unlinked.linkChildren.submit")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
