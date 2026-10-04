import { ApiError } from "@studafy/api-client";
import { Button, Table, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { CriteriaTemplateModal } from "./CriteriaTemplateModal";
import { useDeactivateTemplate, useUpdateTemplate } from "./mutations";
import { evaluationTemplatesListKey, fetchTemplates } from "./queries";

import type { EvaluationCriteriaTemplate } from "./queries";

import "./evaluations.css";

const COLUMN_COUNT = 5;

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

function ActivateButton({ template }: { template: EvaluationCriteriaTemplate }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const update = useUpdateTemplate(template.id);

  return (
    <Button
      type="button"
      variant="tertiary"
      loading={update.isPending}
      onClick={() =>
        update.mutate(
          { is_active: true },
          {
            onSuccess: () =>
              show({ variant: "success", title: t("principal.evaluations.templates.reactivated") }),
            onError: (error) =>
              show({
                variant: "error",
                title: t("principal.evaluations.templates.reactivateFailed"),
                description: apiErrorDescription(error),
              }),
          },
        )
      }
    >
      {t("principal.evaluations.templates.reactivate")}
    </Button>
  );
}

function DeactivateButton({ templateId }: { templateId: string }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const deactivate = useDeactivateTemplate();

  return (
    <Button
      type="button"
      variant="tertiary"
      loading={deactivate.isPending}
      onClick={() =>
        deactivate.mutate(templateId, {
          onSuccess: () =>
            show({ variant: "success", title: t("principal.evaluations.templates.deactivated") }),
          onError: (error) =>
            show({
              variant: "error",
              title: t("principal.evaluations.templates.deactivateFailed"),
              description: apiErrorDescription(error),
            }),
        })
      }
    >
      {t("principal.evaluations.templates.deactivate")}
    </Button>
  );
}

/**
 * Manages the reusable criteria templates `EvaluationDetailPage`'s scoring table draws on
 * (`/portal/principal/evaluations/templates`) — create one, score every evaluation against the same
 * set. Deactivating a template soft-deletes it (`is_active: false`): it drops out of new evaluations'
 * scoring forms without touching scores already recorded against it on past evaluations.
 */
export default function CriteriaTemplatesPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EvaluationCriteriaTemplate | null>(null);

  const templatesQuery = useQuery({
    queryKey: evaluationTemplatesListKey(false),
    queryFn: () => fetchTemplates(false),
  });

  const templates = templatesQuery.data ?? [];

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(template: EvaluationCriteriaTemplate) {
    setEditing(template);
    setModalOpen(true);
  }

  return (
    <>
      <Link className="evaluations-detail__back" to="/portal/principal/evaluations">
        {t("principal.evaluations.backToList")}
      </Link>

      <div className="evaluations-list__header">
        <div>
          <h1>{t("principal.evaluations.templates.title")}</h1>
          <p>{t("principal.evaluations.templates.description")}</p>
        </div>
        <Button type="button" variant="primary" onClick={openCreate}>
          {t("principal.evaluations.templates.newTemplate")}
        </Button>
      </div>

      <Table caption={t("principal.evaluations.templates.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>
              {t("principal.evaluations.templates.columns.title")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.evaluations.templates.columns.maxScore")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.evaluations.templates.columns.sortOrder")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.evaluations.templates.columns.status")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.evaluations.templates.columns.actions")}
            </Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={templatesQuery.isPending}
          empty={
            templatesQuery.isError
              ? t("principal.evaluations.templates.error")
              : t("principal.evaluations.templates.empty")
          }
        >
          {templates.map((template) => (
            <Table.Row key={template.id}>
              <Table.Cell>
                <div className="evaluations-score__title">{template.title}</div>
                {template.description ? (
                  <div className="evaluations-score__description">{template.description}</div>
                ) : null}
              </Table.Cell>
              <Table.Cell>{formatNumber(template.max_score)}</Table.Cell>
              <Table.Cell>{formatNumber(template.sort_order)}</Table.Cell>
              <Table.Cell>
                {template.is_active
                  ? t("principal.evaluations.templates.active")
                  : t("principal.evaluations.templates.inactive")}
              </Table.Cell>
              <Table.Cell>
                <div className="evaluations-detail__workflow-actions">
                  <Button type="button" variant="tertiary" onClick={() => openEdit(template)}>
                    {t("principal.evaluations.templates.edit")}
                  </Button>
                  {template.is_active ? (
                    <DeactivateButton templateId={template.id} />
                  ) : (
                    <ActivateButton template={template} />
                  )}
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <CriteriaTemplateModal
        open={modalOpen}
        template={editing}
        onClose={() => setModalOpen(false)}
      />
    </>
  );
}
