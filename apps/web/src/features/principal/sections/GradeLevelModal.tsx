import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateGradeLevel, useUpdateGradeLevel } from "./mutations";

import type { GradeLevel } from "./queries";

/** Mirrors `createGradeLevelBodySchema`: a 1–100 character name and a 0–32767 sort order. */
const MAX_NAME_LENGTH = 100;
const MAX_SORT_ORDER = 32767;

export interface GradeLevelModalProps {
  open: boolean;
  /** `null` adds a grade; otherwise renames or reorders this one. */
  grade: GradeLevel | null;
  /** Prefilled order for a new grade, so it lands after the existing ones. */
  nextSortOrder: number;
  onClose: () => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/** Adds a grade ("Grade 10") or edits one's name and position in the school's list of grades. */
export function GradeLevelModal({ open, grade, nextSortOrder, onClose }: GradeLevelModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const create = useCreateGradeLevel();
  const update = useUpdateGradeLevel();
  const saving = grade ? update : create;
  const [name, setName] = useState("");
  const [sortOrder, setSortOrder] = useState("0");

  useEffect(() => {
    if (!open) return;
    setName(grade?.name ?? "");
    setSortOrder(String(grade?.sort_order ?? nextSortOrder));
  }, [open, grade, nextSortOrder]);

  const parsedOrder = Number(sortOrder);
  const orderValid =
    sortOrder.trim() !== "" &&
    Number.isInteger(parsedOrder) &&
    parsedOrder >= 0 &&
    parsedOrder <= MAX_SORT_ORDER;
  const canSubmit = name.trim() !== "" && orderValid;

  function handleSubmit() {
    if (!canSubmit) return;
    const body = { name: name.trim(), sort_order: parsedOrder };
    const onSuccess = () => {
      show({
        variant: "success",
        title: grade
          ? t("principal.sections.gradeModal.updated")
          : t("principal.sections.gradeModal.created"),
      });
      onClose();
    };
    const onError = (error: unknown) =>
      show({
        variant: "error",
        title: t("principal.sections.gradeModal.saveFailed"),
        description: apiErrorDescription(error),
      });

    if (grade) {
      update.mutate({ gradeLevelId: grade.id, body }, { onSuccess, onError });
    } else {
      create.mutate(body, { onSuccess, onError });
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        grade
          ? t("principal.sections.gradeModal.editTitle")
          : t("principal.sections.gradeModal.addTitle")
      }
    >
      <Modal.Body>
        <div className="sections-form">
          <Input
            label={t("principal.sections.gradeModal.name")}
            value={name}
            required
            maxLength={MAX_NAME_LENGTH}
            placeholder={t("principal.sections.gradeModal.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            label={t("principal.sections.gradeModal.sortOrder")}
            type="number"
            min={0}
            max={MAX_SORT_ORDER}
            step={1}
            value={sortOrder}
            required
            onChange={(event) => setSortOrder(event.target.value)}
            helperText={t("principal.sections.gradeModal.sortOrderHelper")}
            error={orderValid ? undefined : t("principal.sections.gradeModal.sortOrderInvalid")}
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
          {grade ? t("principal.sections.gradeModal.save") : t("principal.sections.gradeModal.add")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
