import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { DISCIPLINE_ACTION_TYPE_LABEL_KEYS } from "./labels";
import { useCreateAction } from "./mutations";

import type { CreateActionInput } from "./mutations";
import type { SelectOption } from "@studafy/ui";

const ACTION_TYPES = Object.keys(
  DISCIPLINE_ACTION_TYPE_LABEL_KEYS,
) as CreateActionInput["action_type"][];

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
  const { t } = useTranslation();
  const { show } = useToast();
  const [actionType, setActionType] =
    useState<CreateActionInput["action_type"]>(DEFAULT_ACTION_TYPE);
  const [description, setDescription] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveUntil, setEffectiveUntil] = useState("");
  const create = useCreateAction(incidentId);
  const actionTypeOptions: SelectOption<CreateActionInput["action_type"]>[] = ACTION_TYPES.map(
    (value) => ({ value, label: t(DISCIPLINE_ACTION_TYPE_LABEL_KEYS[value]) }),
  );

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
          show({ variant: "success", title: t("principal.discipline.addAction.success") });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("principal.discipline.addAction.failed"),
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t("principal.discipline.addAction.title")}>
      <Modal.Body>
        <div className="discipline-form">
          <Select
            label={t("principal.discipline.addAction.actionType")}
            options={actionTypeOptions}
            value={actionType}
            onChange={setActionType}
          />
          <Input
            label={t("principal.discipline.addAction.details")}
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
            helperText={t("principal.discipline.addAction.detailsHelper")}
          />
          <Input
            label={t("principal.discipline.addAction.effectiveFrom")}
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
          <Input
            label={t("principal.discipline.addAction.effectiveUntil")}
            type="date"
            value={effectiveUntil}
            onChange={(event) => setEffectiveUntil(event.target.value)}
          />
          {create.isError ? (
            <p role="alert" className="discipline-detail__hint">
              {apiErrorDescription(create.error) ??
                t("principal.discipline.addAction.errorFallback")}
            </p>
          ) : null}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("principal.common.cancel")}
        </Button>
        <Button type="button" variant="primary" loading={create.isPending} onClick={handleSubmit}>
          {t("principal.discipline.addAction.submit")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
