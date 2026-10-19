import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateMember } from "./mutations";
import { MEMBER_KINDS } from "./queries";

import type { CreatedMember, NewMemberValues } from "./mutations";
import type { MemberRole } from "./queries";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const EMPTY: NewMemberValues = {
  role: "STUDENT",
  displayName: "",
  firstName: "",
  lastName: "",
  admissionNumber: "",
  employeeNumber: "",
  email: "",
};

type FieldKey = Exclude<keyof NewMemberValues, "role">;

/** The fields each role must fill in; email is always optional. */
const REQUIRED: Record<MemberRole, FieldKey[]> = {
  STUDENT: ["firstName", "lastName", "admissionNumber"],
  INSTRUCTOR: ["displayName", "employeeNumber"],
  PARENT: ["displayName"],
  ATTENDANCE_OFFICER: ["displayName"],
};

export interface AddMemberModalProps {
  open: boolean;
  defaultRole: MemberRole;
  defaultPassword: string;
  onClose: () => void;
}

/**
 * Adds a student, teacher, parent or attendance officer without an email address. On success it
 * shows the ID they sign in with and the starting password, which they must change at first sign-in.
 */
export function AddMemberModal({
  open,
  defaultRole,
  defaultPassword,
  onClose,
}: AddMemberModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateMember();
  const [values, setValues] = useState<NewMemberValues>({ ...EMPTY, role: defaultRole });
  const [missing, setMissing] = useState<Set<FieldKey>>(new Set());
  const [created, setCreated] = useState<CreatedMember | null>(null);

  const roleOptions: SelectOption<MemberRole>[] = MEMBER_KINDS.map((kind) => ({
    value: kind.role,
    label: t(`adminPeople.members.roleNames.${kind.role}`),
  }));

  function set(key: keyof NewMemberValues, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setMissing((prev) => {
      const next = new Set(prev);
      next.delete(key as FieldKey);
      return next;
    });
  }

  function close() {
    setValues({ ...EMPTY, role: defaultRole });
    setMissing(new Set());
    setCreated(null);
    onClose();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const required = REQUIRED[values.role];
    // eslint-disable-next-line security/detect-object-injection -- keys come from the fixed REQUIRED table
    const empty = required.filter((key) => values[key].trim() === "");
    if (empty.length > 0) {
      setMissing(new Set(empty));
      return;
    }
    create.mutate(values, {
      onSuccess: (result) => setCreated(result),
      onError: (error) =>
        show({
          variant: "error",
          title: t("adminPeople.members.add.error"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        }),
    });
  }

  const field = (key: FieldKey, labelKey: string) => (
    <Input
      label={t(labelKey)}
      // eslint-disable-next-line security/detect-object-injection -- `key` is a FieldKey literal from this module
      value={values[key]}
      onChange={(event) => set(key, event.target.value)}
      error={missing.has(key) ? t("adminPeople.members.add.required") : undefined}
      required
    />
  );

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("adminPeople.members.add.title")}
      description={t("adminPeople.members.add.description")}
    >
      {created ? (
        <>
          <Modal.Body>
            <p role="status">{t("adminPeople.members.add.created")}</p>
            <dl className="members-credentials">
              <dt>{t("adminPeople.members.username")}</dt>
              <dd>
                <code>{created.usernames.join(", ")}</code>
              </dd>
              <dt>{t("adminPeople.members.startingPassword")}</dt>
              <dd>
                <code>{defaultPassword}</code>
              </dd>
            </dl>
            <p>{t("adminPeople.members.mustChangeNote")}</p>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" variant="tertiary" onClick={() => setCreated(null)}>
              {t("adminPeople.members.add.another")}
            </Button>
            <Button type="button" onClick={close}>
              {t("adminPeople.members.add.done")}
            </Button>
          </Modal.Footer>
        </>
      ) : (
        <form onSubmit={submit} noValidate aria-label={t("adminPeople.members.add.title")}>
          <Modal.Body>
            <Select
              label={t("adminPeople.members.add.role")}
              options={roleOptions}
              value={values.role}
              onChange={(role) => set("role", role)}
              required
            />
            {values.role === "STUDENT" ? (
              <>
                {field("firstName", "adminPeople.members.add.firstName")}
                {field("lastName", "adminPeople.members.add.lastName")}
                {field("admissionNumber", "adminPeople.members.add.admissionNumber")}
              </>
            ) : (
              field("displayName", "adminPeople.members.add.fullName")
            )}
            {values.role === "INSTRUCTOR"
              ? field("employeeNumber", "adminPeople.members.add.employeeNumber")
              : null}
            <Input
              label={t("adminPeople.members.add.emailOptional")}
              type="email"
              value={values.email}
              onChange={(event) => set("email", event.target.value)}
            />
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" variant="tertiary" onClick={close}>
              {t("adminPeople.common.cancel")}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t("adminPeople.members.add.submit")}
            </Button>
          </Modal.Footer>
        </form>
      )}
    </Modal>
  );
}
