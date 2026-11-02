import { ApiError } from "@studafy/api-client";
import { ROLES } from "@studafy/constants";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { answersFromDrafts, RecordsFormSection } from "../../records/RecordsFormSection";
import { ChildrenPicker } from "../people-links/LinkPickers";

import { useCreateUser } from "./mutations";
import { ASSIGNABLE_ROLES, createUserSchema, fieldErrors, ROLE_LABEL_KEYS } from "./schema";

import type { CreateUserValues } from "./schema";
import type { RecordFieldDefinition } from "../../records/queries";
import type { RecordDrafts } from "../../records/RecordsFormSection";
import type { ChildDraft } from "../people-links/LinkPickers";
import type { Role } from "@studafy/constants";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const EMPTY_VALUES = { email: "", display_name: "", role: ASSIGNABLE_ROLES[0]! };

export interface CreateUserModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * `parent:link`, which user creation (`user:create`) does not imply: without it the API refuses
   * `children`, so the link step is not shown at all.
   */
  canLinkChildren: boolean;
  /**
   * `studentRecord:update`, which `user:create` does not imply either: a new PARENT's record can be
   * filled in with the account, and without it the step is not shown at all.
   */
  canFillRecords?: boolean;
  /** The role the form starts on (and resets to); the first assignable role when omitted. */
  initialRole?: Role;
}

/**
 * `POST /api/users` — the new account is created with `invited` status; nothing signs them in here.
 * Choosing the PARENT role adds an optional "link children" step: staff pick the students
 * themselves and they are linked in the same call, so the parent starts in a family instead of
 * waiting for someone to link them from each child's profile.
 */
export function CreateUserModal({
  open,
  onClose,
  canLinkChildren,
  canFillRecords = false,
  initialRole,
}: CreateUserModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createUser = useCreateUser();

  const roleOptions: SelectOption<Role>[] = ASSIGNABLE_ROLES.map((role) => ({
    value: role,
    // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `ASSIGNABLE_ROLES` array, not user input
    label: t(ROLE_LABEL_KEYS[role]),
  }));

  const startValues = initialRole ? { ...EMPTY_VALUES, role: initialRole } : EMPTY_VALUES;
  const [values, setValues] = useState(startValues);
  const [children, setChildren] = useState<ChildDraft[]>([]);
  const [errors, setErrors] = useState<Partial<Record<keyof CreateUserValues, string>>>({});
  const [recordDrafts, setRecordDrafts] = useState<RecordDrafts>({});
  const [recordFields, setRecordFields] = useState<RecordFieldDefinition[]>([]);
  const showChildren = canLinkChildren && values.role === ROLES.PARENT;
  const showRecords = canFillRecords && values.role === ROLES.PARENT;

  function setField<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function reset() {
    setValues(startValues);
    setChildren([]);
    setRecordDrafts({});
    setRecordFields([]);
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

    const links = showChildren
      ? children.map((draft) => ({
          student_id: draft.student.id,
          relationship: draft.relationship,
        }))
      : [];

    const records = showRecords ? answersFromDrafts(recordFields, recordDrafts) : [];

    createUser.mutate(
      {
        ...result.data,
        children: links.length > 0 ? links : undefined,
        records: records.length > 0 ? records : undefined,
      },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("adminPeople.users.create.invitedToast", { email: result.data.email }),
          });
          handleClose();
        },
        onError: (error) => {
          show({
            variant: "error",
            title: t("adminPeople.users.create.error"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("adminPeople.users.create.title")}
      description={t("adminPeople.users.create.description")}
    >
      <form onSubmit={handleSubmit} noValidate aria-label={t("adminPeople.users.create.title")}>
        <Modal.Body>
          <Input
            label={t("adminPeople.users.form.email")}
            type="email"
            value={values.email}
            onChange={(e) => setField("email", e.target.value)}
            error={errors.email && t(errors.email)}
            required
            autoFocus
          />
          <Input
            label={t("adminPeople.users.form.displayName")}
            value={values.display_name}
            onChange={(e) => setField("display_name", e.target.value)}
            error={errors.display_name && t(errors.display_name)}
            required
          />
          <Select
            label={t("adminPeople.users.form.role")}
            options={roleOptions}
            value={values.role}
            onChange={(value) => setField("role", value)}
            required
          />
          {showChildren ? <ChildrenPicker value={children} onChange={setChildren} /> : null}
          {showRecords && open ? (
            <RecordsFormSection
              kind="parent"
              drafts={recordDrafts}
              onChange={(drafts, fields) => {
                setRecordDrafts(drafts);
                setRecordFields(fields);
              }}
            />
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            {t("adminPeople.common.cancel")}
          </Button>
          <Button type="submit" loading={createUser.isPending}>
            {t("adminPeople.users.create.submit")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
