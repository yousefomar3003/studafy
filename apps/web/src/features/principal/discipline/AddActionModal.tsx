import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { DISCIPLINE_ACTION_TYPE_LABELS } from "./labels";
import { useCreateAction } from "./mutations";

import type { CreateActionInput } from "./mutations";
import type { SelectOption } from "@studafy/ui";

const ACTION_TYPE_OPTIONS = Object.entries(DISCIPLINE_ACTION_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
})) as SelectOption<CreateActionInput["action_type"]>[];

const DEFAULT_ACTION_TYPE: CreateActionInput["action_type"] = "verbal_warning";

export interface AddActionModalProps {
  open: boolean;
  incidentId: string;
  onClose: () => void;
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * Records one disciplinary action against an incident. An incident can't be resolved until it has
 * at least one of these (see `IncidentDetailPage.tsx`'s Resolve gating), so this is the workflow's
 * required step between "reported"/"under review" and "resolved".
 */
export function AddActionModal({ open, incidentId, onClose }: AddActionModalProps) {
  const { show } = useToast();
  const [actionType, setActionType] =
    useState<CreateActionInput["action_type"]>(DEFAULT_ACTION_TYPE);
  const [description, setDescription] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveUntil, setEffectiveUntil] = useState("");
  const create = useCreateAction(incidentId);

  useEffect(() => {
    if (!open) return;
    setActionType(DEFAULT_ACTION_TYPE);
    setDescription("");
    setEffectiveFrom("");
    setEffectiveUntil("");
  }, [open]);

  function handleSubmit() {
    create.mutate(
      {
        action_type: actionType,
        description: description.trim() || undefined,
        effective_from: effectiveFrom || undefined,
        effective_until: effectiveUntil || undefined,
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: "Action recorded" });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: "Couldn't record action",
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Record a disciplinary action">
      <Modal.Body>
        <div className="discipline-form">
          <Select
            label="Action type"
            options={ACTION_TYPE_OPTIONS}
            value={actionType}
            onChange={setActionType}
          />
          <Input
            label="Details"
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
            helperText="Optional — what the action involved."
          />
          <Input
            label="Effective from"
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
          <Input
            label="Effective until"
            type="date"
            value={effectiveUntil}
            onChange={(event) => setEffectiveUntil(event.target.value)}
          />
          {create.isError ? (
            <p role="alert" className="discipline-detail__hint">
              {apiErrorDescription(create.error) ?? "The action could not be recorded."}
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="primary" loading={create.isPending} onClick={handleSubmit}>
          Record action
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
