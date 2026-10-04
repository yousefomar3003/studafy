import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateInvitation } from "./mutations";
import { createInvitationSchema, fieldErrors, INVITATION_ROLES, ROLE_LABEL_KEYS } from "./schema";

import type { InviteLinkDetails } from "./InviteLinkDialog";
import type { CreateInvitationValues, InvitationRole } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

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
  const { t } = useTranslation();
  const { show } = useToast();
  const createInvitation = useCreateInvitation();

  const roleOptions: SelectOption<InvitationRole>[] = INVITATION_ROLES.map((role) => ({
    value: role,
    // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `INVITATION_ROLES` array, not user input
    label: t(ROLE_LABEL_KEYS[role]),
  }));

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
        show({
          variant: "success",
          title: t("adminPeople.invitations.create.invitedToast", { email: result.data.email }),
        });
        handleClose();
        onCreated({ email: data.invitation.email, token: data.token });
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminPeople.invitations.create.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("adminPeople.invitations.create.title")}
      description={t("adminPeople.invitations.create.description")}
    >
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label={t("adminPeople.invitations.create.title")}
      >
        <Modal.Body>
          <Input
            label={t("adminPeople.invitations.form.email")}
            type="email"
            value={values.email}
            onChange={(e) => setField("email", e.target.value)}
            error={errors.email && t(errors.email)}
            required
            autoFocus
          />
          <Select
            label={t("adminPeople.invitations.form.role")}
            options={roleOptions}
            value={values.role}
            onChange={(value) => setField("role", value)}
            required
          />
          <Input
            label={t("adminPeople.invitations.form.expiresAfter")}
            type="number"
            min={1}
            max={365}
            value={values.expiry_days}
            onChange={(e) => setField("expiry_days", e.target.value)}
            error={errors.expiry_days && t(errors.expiry_days)}
            helperText={t("adminPeople.invitations.create.expiresHelper")}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            {t("adminPeople.common.cancel")}
          </Button>
          <Button type="submit" loading={createInvitation.isPending}>
            {t("adminPeople.invitations.create.submit")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
