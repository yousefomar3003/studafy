import { Button, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";

export interface InviteLinkDetails {
  email: string;
  /** The raw, one-time-use token. Only ever available right after create/resend — the API never
   * returns it again, so this dialog is the only place a copyable link can come from. */
  token: string;
}

export interface InviteLinkDialogProps {
  details: InviteLinkDetails | null;
  onClose: () => void;
}

function inviteLinkFor(token: string): string {
  return `${window.location.origin}/invite/${encodeURIComponent(token)}`;
}

/**
 * Copy-link fallback shown immediately after an invitation is created or resent, for when email
 * delivery is slow, blocked, or the admin wants to hand the link over directly. This is the only
 * moment the link exists client-side: the raw token is never persisted server-side and no endpoint
 * can retrieve it again later (see `apps/api/src/modules/auth/invitation/service.ts`).
 *
 * Reachable only from `InvitationsListPage`, which is gated behind `organization:manageSettings` —
 * the same permission set (`SUPER_ADMIN`/`ORG_ADMIN`) the backend itself requires to create, resend,
 * or revoke an invitation. There is no broader audience to additionally exclude here.
 */
export function InviteLinkDialog({ details, onClose }: InviteLinkDialogProps) {
  const { show } = useToast();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!details) return;
    const link = inviteLinkFor(details.token);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      show({ variant: "success", title: "Link copied" });
    } catch {
      show({
        variant: "error",
        title: "Couldn't copy the link",
        description: "Select the link text and copy it manually.",
      });
    }
  }

  function handleClose() {
    setCopied(false);
    onClose();
  }

  return (
    <Modal
      open={details !== null}
      onClose={handleClose}
      title="Invitation sent"
      description={
        details ? `${details.email} — share this link if the email doesn't arrive.` : undefined
      }
    >
      <Modal.Body>
        <div className="invitations-link-row">
          <Input
            label="Invite link"
            readOnly
            value={details ? inviteLinkFor(details.token) : ""}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button type="button" variant="secondary" onClick={handleCopy}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" onClick={handleClose}>
          Done
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
