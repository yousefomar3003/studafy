import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

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
      show({ variant: "success", title: template ? "Template updated" : "Template created" });
      onClose();
    };
    const onError = (error: unknown) =>
      show({
        variant: "error",
        title: template ? "Couldn't update template" : "Couldn't create template",
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
      title={template ? "Edit criteria template" : "New criteria template"}
    >
      <Modal.Body>
        <div className="evaluations-form">
          <Input
            label="Title"
            value={title}
            required
            onChange={(event) => setTitle(event.target.value)}
          />
          <Input
            label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            helperText="Optional — what this criterion evaluates."
          />
          <Input
            label="Max score"
            type="number"
            min={1}
            value={maxScore}
            onChange={(event) => setMaxScore(event.target.value)}
          />
          <Input
            label="Sort order"
            type="number"
            min={0}
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            helperText="Lower numbers appear first in the scoring form."
          />
          {saving.isError ? (
            <p role="alert" className="evaluations-detail__hint">
              {apiErrorDescription(saving.error) ?? "The template could not be saved."}
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          loading={saving.isPending}
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          {template ? "Save changes" : "Create template"}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
