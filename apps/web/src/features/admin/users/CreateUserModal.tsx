import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useCreateUser } from "./mutations";
import { ASSIGNABLE_ROLES, createUserSchema, fieldErrors, ROLE_LABELS } from "./schema";

import type { CreateUserValues } from "./schema";
import type { Role } from "@studafy/constants";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const ROLE_OPTIONS: SelectOption<Role>[] = ASSIGNABLE_ROLES.map((role) => ({
  value: role,
  // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `ASSIGNABLE_ROLES` array, not user input
  label: ROLE_LABELS[role],
}));

const EMPTY_VALUES = { email: "", display_name: "", role: ASSIGNABLE_ROLES[0]! };

export interface CreateUserModalProps {
  open: boolean;
  onClose: () => void;
}

/** `POST /api/users` — the new account is created with `invited` status; nothing signs them in here. */
export function CreateUserModal({ open, onClose }: CreateUserModalProps) {
  const { show } = useToast();
  const createUser = useCreateUser();

  const [values, setValues] = useState(EMPTY_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateUserValues, string>>>({});

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
    const result = createUserSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    createUser.mutate(result.data, {
      onSuccess: () => {
        show({ variant: "success", title: `Invited ${result.data.email}` });
        handleClose();
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't create user",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New user"
      description="Invite someone to this school."
    >
      <form onSubmit={handleSubmit} noValidate aria-label="New user">
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
          <Input
            label="Display name"
            value={values.display_name}
            onChange={(e) => setField("display_name", e.target.value)}
            error={errors.display_name}
            helperText="Optional — they can set this themselves once they accept the invite."
          />
          <Select
            label="Role"
            options={ROLE_OPTIONS}
            value={values.role}
            onChange={(value) => setField("role", value)}
            required
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={createUser.isPending}>
            Send invite
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
