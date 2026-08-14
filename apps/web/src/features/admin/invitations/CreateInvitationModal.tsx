import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useCreateInvitation } from "./mutations";
import { createInvitationSchema, fieldErrors, INVITATION_ROLES, ROLE_LABELS } from "./schema";

import type { InviteLinkDetails } from "./InviteLinkDialog";
import type { CreateInvitationValues, InvitationRole } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const ROLE_OPTIONS: SelectOption<InvitationRole>[] = INVITATION_ROLES.map((role) => ({
  value: role,
  // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `INVITATION_ROLES` array, not user input
  label: ROLE_LABELS[role],
}));

const EMPTY_VALUES = { email: "", role: INVITATION_ROLES[0] as InvitationRole, expiry_days: "" };

export interface CreateInvitationModalProps {
  open: boolean;
  onClose: () => void;
  /** Hands the newly-minted token up so the caller can open `InviteLinkDialog` on top of this one. */
  onCreated: (details: InviteLinkDetails) => void;
}

/** `POST /api/invitations` — issues a token-based invitation, distinct from the users feature's
 * `POST /api/users` (which creates an account row directly, no token exchange). */
export function CreateInvitationModal({ open, onClose, onCreated }: CreateInvitationModalProps) {
  const { show } = useToast();
  const createInvitation = useCreateInvitation();

  const [values, setValues] = useState(EMPTY_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateInvitationValues, string>>>({});

  function setField<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function reset() {
    setValues(EMPTY_VALUES);
    setErrors({});
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const result = createInvitationSchema.safeParse({
      email: values.email,
      role: values.role,
      expiry_days: values.expiry_days ? Number(values.expiry_days) : undefined,
    });
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    createInvitation.mutate(result.data, {
      onSuccess: (data) => {
        show({ variant: "success", title: `Invited ${result.data.email}` });
        handleClose();
        onCreated({ email: data.invitation.email, token: data.token });
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't create invitation",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New invitation"
      description="Issue a one-time invite link for someone to join this school."
    >
      <form onSubmit={handleSubmit} noValidate aria-label="New invitation">
        <Modal.Body>
          <Input
            label="Email"
            type="email"
            value={values.email}
            onChange={(e) => setField("email", e.target.value)}
            error={errors.email}
            required
            autoFocus
          />
          <Select
            label="Role"
            options={ROLE_OPTIONS}
            value={values.role}
            onChange={(value) => setField("role", value)}
            required
          />
          <Input
            label="Expires after (days)"
            type="number"
            min={1}
            max={365}
            value={values.expiry_days}
            onChange={(e) => setField("expiry_days", e.target.value)}
            error={errors.expiry_days}
            helperText="Optional — defaults to 7 days."
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={createInvitation.isPending}>
            Send invite
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
