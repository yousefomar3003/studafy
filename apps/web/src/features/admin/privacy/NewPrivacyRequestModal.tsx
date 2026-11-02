import { ApiError } from "@studafy/api-client";
import { ERROR_CODES } from "@studafy/constants";
import { Button, Checkbox, Modal, Radio, RadioGroup, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { ActorFilterField } from "../audit/ActorFilterField";

import { useFilePrivacyRequest } from "./queries";

import type { PrivacyRequestType } from "./queries";
import type { UserWithRoles } from "../audit/queries";
import type { TFunction } from "i18next";

import "../audit/audit.css";

export interface NewPrivacyRequestModalProps {
  open: boolean;
  onClose: () => void;
}

function fileErrorDescription(error: unknown, t: TFunction): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === ERROR_CODES.DSR_ALREADY_PENDING) {
    return t("adminSchool.privacy.new.alreadyPending");
  }
  if (error.code === ERROR_CODES.DSR_UNAVAILABLE) return t("adminSchool.privacy.new.unavailable");
  return error.detail ?? error.title;
}

/**
 * Files an export or an erasure about one person in the school. An erasure removes their
 * personal data for good (records kept by law, such as paid invoices, are retained without it), so
 * it needs the admin to tick that they understand before it can be filed.
 */
export function NewPrivacyRequestModal({ open, onClose }: NewPrivacyRequestModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const fileRequest = useFilePrivacyRequest();
  const [person, setPerson] = useState<UserWithRoles | null>(null);
  const [type, setType] = useState<PrivacyRequestType>("export");
  const [understood, setUnderstood] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPerson(null);
    setType("export");
    setUnderstood(false);
  }, [open]);

  const canSubmit = person !== null && (type === "export" || understood);

  function handleSubmit() {
    if (!person || !canSubmit) return;
    fileRequest.mutate(
      { subject_user_id: person.id, request_type: type },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t(`adminSchool.privacy.new.filed.${type}`, {
              name: person.display_name ?? person.email,
            }),
          });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("adminSchool.privacy.new.failed"),
            description: fileErrorDescription(error, t),
          }),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t("adminSchool.privacy.new.title")}>
      <Modal.Body>
        <div className="privacy-form">
          <ActorFilterField
            label={t("adminSchool.privacy.new.person")}
            value={person}
            onChange={setPerson}
          />
          <RadioGroup
            label={t("adminSchool.privacy.new.type")}
            name="privacy-request-type"
            value={type}
            onChange={(value) => {
              setType(value as PrivacyRequestType);
              setUnderstood(false);
            }}
          >
            <Radio value="export" label={t("adminSchool.privacy.type.export")} />
            <Radio value="erasure" label={t("adminSchool.privacy.type.erasure")} />
          </RadioGroup>
          <p className="privacy-form__explain">{t(`adminSchool.privacy.new.explain.${type}`)}</p>
          {type === "erasure" ? (
            <Checkbox
              label={t("adminSchool.privacy.new.understandErasure")}
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("adminSchool.privacy.new.cancel")}
        </Button>
        <Button
          type="button"
          loading={fileRequest.isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t(`adminSchool.privacy.new.submit.${type}`)}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
