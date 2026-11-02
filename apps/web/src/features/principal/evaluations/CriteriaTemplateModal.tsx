import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateTemplate, useUpdateTemplate } from "./mutations";

import type { EvaluationCriteriaTemplate } from "./queries";

export interface CriteriaTemplateModalProps {
  open: boolean;
  /** `null` creates a new template; otherwise edits this one. */
  template: EvaluationCriteriaTemplate | null;
  onClose: () => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * Creates a new criteria template or edits an existing one — same fields either way, since
 * `UpdateCriteriaTemplateBody` mirrors `CreateCriteriaTemplateBody` apart from `is_active`, which
 * this modal doesn't touch (see `CriteriaTemplatesPage`'s activate/deactivate buttons instead).
 * Once created, a template is reused across every evaluation's scoring form — that reuse is what
 * `EvaluationDetailPage`'s criteria table draws on.
 */
export function CriteriaTemplateModal({ open, template, onClose }: CriteriaTemplateModalProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [maxScore, setMaxScore] = useState("10");
  const [sortOrder, setSortOrder] = useState("0");
  const create = useCreateTemplate();
  const update = useUpdateTemplate(template?.id ?? "");
  const saving = template ? update : create;

  useEffect(() => {
    if (!open) return;
    setTitle(template?.title ?? "");
    setDescription(template?.description ?? "");
    setMaxScore(template ? String(template.max_score) : "10");
    setSortOrder(template ? String(template.sort_order) : "0");
  }, [open, template]);

  const parsedMaxScore = Number(maxScore);
  const canSubmit = title.trim() !== "" && Number.isFinite(parsedMaxScore) && parsedMaxScore > 0;

  function handleSubmit() {
    if (!canSubmit) return;

    const input = {
      title: title.trim(),
      description: description.trim() || undefined,
      max_score: parsedMaxScore,
      sort_order: Number(sortOrder) || 0,
    };
    const onSuccess = () => {
      show({
        variant: "success",
        title: template
          ? t("principal.evaluations.templateModal.updated")
          : t("principal.evaluations.templateModal.created"),
      });
      onClose();
    };
    const onError = (error: unknown) =>
      show({
        variant: "error",
        title: template
          ? t("principal.evaluations.templateModal.updateFailed")
          : t("principal.evaluations.templateModal.createFailed"),
        description: apiErrorDescription(error),
      });

    if (template) {
      update.mutate(input, { onSuccess, onError });
    } else {
      create.mutate(input, { onSuccess, onError });
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        template
          ? t("principal.evaluations.templateModal.editTitle")
          : t("principal.evaluations.templateModal.newTitle")
      }
    >
      <Modal.Body>
        <div className="evaluations-form">
          <Input
            label={t("principal.evaluations.templateModal.title")}
            value={title}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
          <Input
            label={t("principal.evaluations.templateModal.description")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            helperText={t("principal.evaluations.templateModal.descriptionHelper")}
          />
          <Input
            label={t("principal.evaluations.templateModal.maxScore")}
            type="number"
            min={1}
            value={maxScore}
            onChange={(event) => setMaxScore(event.target.value)}
          />
          <Input
            label={t("principal.evaluations.templateModal.sortOrder")}
            type="number"
            min={0}
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            helperText={t("principal.evaluations.templateModal.sortOrderHelper")}
          />
          {saving.isError ? (
            <p role="alert" className="evaluations-detail__hint">
              {apiErrorDescription(saving.error) ??
                t("principal.evaluations.templateModal.errorFallback")}
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={saving.isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {template
            ? t("principal.evaluations.templateModal.saveChanges")
            : t("principal.evaluations.templateModal.create")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
