import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useId, useState } from "react";

import { useCreateBulkInvite } from "./mutations";
import {
  bulkInviteSchema,
  fieldErrors,
  INVITATION_ROLES,
  parseRecipients,
  ROLE_LABELS,
} from "./schema";

import type { InvitationRole } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const ROLE_OPTIONS: SelectOption<InvitationRole>[] = INVITATION_ROLES.map((role) => ({
  value: role,
  // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `INVITATION_ROLES` array, not user input
  label: ROLE_LABELS[role],
}));

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
  const { show } = useToast();
  const createBulkInvite = useCreateBulkInvite();
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
          title: `Bulk invite queued`,
          description: `${data.total_count} recipient${data.total_count === 1 ? "" : "s"} — dispatch is running in the background.`,
        });
        handleClose();
        onCreated(data.id);
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't create bulk invite",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Bulk invite"
      description="Invite many people at once. Each recipient is tracked and retriable individually."
    >
      <form onSubmit={handleSubmit} noValidate aria-label="Bulk invite">
        <Modal.Body>
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={recipientsId}>
              Recipients
              <span className="sf-field__required" aria-hidden="true">
                *
              </span>
            </label>
            <div className="sf-input invitations-recipients-input">
              <textarea
                id={recipientsId}
                className="sf-input__control"
                rows={6}
                placeholder="One email per line, or separated by commas"
                value={values.recipientsText}
                onChange={(e) => setField("recipientsText", e.target.value)}
                aria-invalid={errors.recipients ? true : undefined}
                required
              />
            </div>
            <p className="sf-field__helper">
              {recipients.length} recipient{recipients.length === 1 ? "" : "s"} detected. Maximum
              5,000 per batch.
            </p>
            {errors.recipients ? (
              <p className="sf-field__error" role="alert">
                {errors.recipients}
              </p>
            ) : null}
          </div>

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
            helperText="Optional — defaults to 7 days for every recipient."
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={createBulkInvite.isPending}>
            Send {recipients.length || ""} invite{recipients.length === 1 ? "" : "s"}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
