import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useUpdateCourse, useUpdateSubject } from "./mutations";

import type { Course, Subject } from "../school/queries";

/** Mirrors the API's subject and course bodies. */
const MAX_CODE_LENGTH = 50;
const MAX_NAME_LENGTH = 200;
const CATALOG_STATUSES = ["draft", "active", "inactive", "archived"] as const;
type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export type CatalogItem = { kind: "subject"; item: Subject } | { kind: "course"; item: Course };

export interface CatalogItemModalProps {
  target: CatalogItem | null;
  onClose: () => void;
}

/** Edits a subject's or a course's code, name, status (and a course's credit hours). */
export function CatalogItemModal({ target, onClose }: CatalogItemModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const updateSubject = useUpdateSubject();
  const updateCourse = useUpdateCourse();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<CatalogStatus>("active");
  const [credits, setCredits] = useState("");

  useEffect(() => {
    if (!target) return;
    setCode(target.item.code);
    setName(target.item.name);
    setStatus(target.item.status as CatalogStatus);
    setCredits(target.kind === "course" ? String(target.item.credit_hours) : "");
  }, [target]);

  const parsedCredits = Number(credits);
  const creditsValid =
    target?.kind !== "course" ||
    (credits.trim() !== "" && Number.isFinite(parsedCredits) && parsedCredits > 0);
  const canSubmit = code.trim() !== "" && name.trim() !== "" && creditsValid;
  const saving = target?.kind === "course" ? updateCourse : updateSubject;
  const prefix = `principal.catalog.modal.${target?.kind ?? "subject"}`;

  function handleSubmit() {
    if (!target || !canSubmit) return;
    const fields = { code: code.trim(), name: name.trim(), status };
    const onSuccess = () => {
      show({ variant: "success", title: t(`${prefix}.saved`) });
      onClose();
    };
    const onError = (error: unknown) =>
      show({
        variant: "error",
        title: t(`${prefix}.saveFailed`),
        description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
      });
    if (target.kind === "subject") {
      updateSubject.mutate({ subjectId: target.item.id, body: fields }, { onSuccess, onError });
    } else {
      // Credits are fixed once a course has published grades, so they are sent only when changed.
      const body =
        parsedCredits === target.item.credit_hours
          ? fields
          : { ...fields, credit_hours: parsedCredits };
      updateCourse.mutate({ courseId: target.item.id, body }, { onSuccess, onError });
    }
  }

  return (
    <Modal open={target !== null} onClose={onClose} title={t(`${prefix}.title`)}>
      <Modal.Body>
        <div className="sections-form">
          <Input
            label={t("principal.catalog.modal.name")}
            value={name}
            required
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            label={t("principal.catalog.modal.code")}
            value={code}
            required
            maxLength={MAX_CODE_LENGTH}
            onChange={(event) => setCode(event.target.value)}
          />
          {target?.kind === "course" ? (
            <Input
              label={t("principal.catalog.modal.credits")}
              type="number"
              min={0.5}
              step="0.5"
              required
              value={credits}
              onChange={(event) => setCredits(event.target.value)}
              error={creditsValid ? undefined : t("principal.catalog.modal.creditsInvalid")}
            />
          ) : null}
          <Select
            label={t("principal.catalog.modal.status")}
            options={CATALOG_STATUSES.map((value) => ({
              value,
              label: t(`principal.catalog.status.${value}`),
            }))}
            value={status}
            onChange={(value) => setStatus(value as CatalogStatus)}
            helperText={t("principal.catalog.modal.statusHelper")}
          />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button
          type="button"
          loading={saving.isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {t("principal.catalog.modal.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
