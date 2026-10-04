import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateBulkInvite } from "./mutations";
import {
  bulkInviteSchema,
  fieldErrors,
  INVITATION_ROLES,
  parseRecipients,
  ROLE_LABEL_KEYS,
} from "./schema";

import type { InvitationRole } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const EMPTY_VALUES = {
  recipientsText: "",
  role: INVITATION_ROLES[0] as InvitationRole,
  expiry_days: "",
};

export interface BulkInviteModalProps {
  open: boolean;
  onClose: () => void;
  /** Fires once the batch is queued, so the caller can jump straight to its progress panel. */
  onCreated: (bulkInviteId: string) => void;
}

/** `POST /api/invitations/bulk` — issues up to 5,000 invitations as one batch, processed async. */
export function BulkInviteModal({ open, onClose, onCreated }: BulkInviteModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createBulkInvite = useCreateBulkInvite();

  const roleOptions: SelectOption<InvitationRole>[] = INVITATION_ROLES.map((role) => ({
    value: role,
    // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `INVITATION_ROLES` array, not user input
    label: t(ROLE_LABEL_KEYS[role]),
  }));
  const recipientsId = useId();

  const [values, setValues] = useState(EMPTY_VALUES);
  const [errors, setErrors] = useState<
    Partial<Record<"recipients" | "role" | "expiry_days", string>>
  >({});

  function setField<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key === "recipientsText" ? "recipients" : key]: undefined }));
  }

  function reset() {
    setValues(EMPTY_VALUES);
    setErrors({});
  }

  function handleClose() {
    reset();
    onClose();
  }

  const recipients = parseRecipients(values.recipientsText);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const result = bulkInviteSchema.safeParse({
      role: values.role,
      expiry_days: values.expiry_days ? Number(values.expiry_days) : undefined,
      recipients,
    });
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    createBulkInvite.mutate(result.data, {
      onSuccess: (data) => {
        show({
          variant: "success",
          title: t("adminPeople.invitations.bulkModal.queuedToast"),
          description: t("adminPeople.invitations.bulkModal.queuedDescription", {
            count: data.total_count,
          }),
        });
        handleClose();
        onCreated(data.id);
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminPeople.invitations.bulkModal.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("adminPeople.invitations.bulkModal.title")}
      description={t("adminPeople.invitations.bulkModal.description")}
    >
      <form
        onSubmit={handleSubmit}
        noValidate
        aria-label={t("adminPeople.invitations.bulkModal.title")}
      >
        <Modal.Body>
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={recipientsId}>
              {t("adminPeople.invitations.bulkModal.recipients")}
              <span className="sf-field__required" aria-hidden="true">
                *
              </span>
            </label>
            <div className="sf-input invitations-recipients-input">
              <textarea
                id={recipientsId}
                className="sf-input__control"
                rows={6}
                placeholder={t("adminPeople.invitations.bulkModal.placeholder")}
                value={values.recipientsText}
                onChange={(e) => setField("recipientsText", e.target.value)}
                aria-invalid={errors.recipients ? true : undefined}
                required
              />
            </div>
            <p className="sf-field__helper">
              {t("adminPeople.invitations.bulkModal.detected", { count: recipients.length })}
            </p>
            {errors.recipients ? (
              <p className="sf-field__error" role="alert">
                {t(errors.recipients)}
              </p>
            ) : null}
          </div>

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
            helperText={t("adminPeople.invitations.bulkModal.expiresHelper")}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            {t("adminPeople.common.cancel")}
          </Button>
          <Button type="submit" loading={createBulkInvite.isPending}>
            {t("adminPeople.invitations.bulkModal.submit", { count: recipients.length })}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
