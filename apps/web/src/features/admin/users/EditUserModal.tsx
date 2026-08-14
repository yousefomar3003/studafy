import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useUpdateUser, useUpdateUserRole } from "./mutations";
import { ASSIGNABLE_ROLES, editUserSchema, fieldErrors, ROLE_LABELS } from "./schema";

import type { UserWithRoles } from "./queries";
import type { EditUserValues } from "./schema";
import type { Role } from "@studafy/constants";
import type { FormEvent } from "react";

const ROLE_OPTIONS = ASSIGNABLE_ROLES.map((role) => ({
  value: role,
  // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `ASSIGNABLE_ROLES` array, not user input
  label: ROLE_LABELS[role],
}));
const EMPTY_VALUES: EditUserValues = { display_name: "", role: ASSIGNABLE_ROLES[0]! };

function valuesFor(user: UserWithRoles): EditUserValues {
  return {
    display_name: user.display_name ?? "",
    // Assignable-role narrowing (see schema.ts) means an existing SUPER_ADMIN's role won't appear
    // in the picker; falling back to their current role keeps the field truthful rather than
    // silently substituting a different one the picker does offer.
    role: (user.roles[0] as Role | undefined) ?? ASSIGNABLE_ROLES[0]!,
  };
}

export interface EditUserModalProps {
  user: UserWithRoles | null;
  onClose: () => void;
}

/** Combines `PATCH /api/users/{userId}` (display name) and `PATCH .../role` behind one save action. */
export function EditUserModal({ user, onClose }: EditUserModalProps) {
  const { show } = useToast();
  const updateUser = useUpdateUser();
  const updateUserRole = useUpdateUserRole();

  const [values, setValues] = useState<EditUserValues>(() =>
    user ? valuesFor(user) : EMPTY_VALUES,
  );
  const [errors, setErrors] = useState<Partial<Record<keyof EditUserValues, string>>>({});

  useEffect(() => {
    if (user) {
      setValues(valuesFor(user));
      setErrors({});
    }
  }, [user]);

  function setField<K extends keyof EditUserValues>(key: K, value: EditUserValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  const saving = updateUser.isPending || updateUserRole.isPending;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!user) return;

    const result = editUserSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    const currentRole = user.roles[0] as Role | undefined;
    const tasks: Promise<unknown>[] = [];
    if (result.data.display_name !== (user.display_name ?? "")) {
      tasks.push(
        updateUser.mutateAsync({ userId: user.id, display_name: result.data.display_name }),
      );
    }
    if (result.data.role !== currentRole) {
      tasks.push(updateUserRole.mutateAsync({ userId: user.id, role: result.data.role }));
    }

    if (tasks.length === 0) {
      onClose();
      return;
    }

    try {
      await Promise.all(tasks);
      show({ variant: "success", title: "User updated" });
      onClose();
    } catch (error) {
      show({
        variant: "error",
        title: "Couldn't save changes",
        description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
      });
    }
  }

  return (
    <Modal open={user !== null} onClose={onClose} title="Edit user" description={user?.email}>
      <form onSubmit={handleSubmit} noValidate aria-label="Edit user">
        <Modal.Body>
          <Input
            label="Display name"
            value={values.display_name}
            onChange={(e) => setField("display_name", e.target.value)}
            error={errors.display_name}
            required
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
          <Button type="button" variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save changes
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
