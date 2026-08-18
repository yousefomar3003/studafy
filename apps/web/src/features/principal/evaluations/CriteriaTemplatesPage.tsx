import { ApiError } from "@studafy/api-client";
import { Button, Table, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

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
            onSuccess: () => show({ variant: "success", title: "Template reactivated" }),
            onError: (error) =>
              show({
                variant: "error",
                title: "Couldn't reactivate template",
                description: apiErrorDescription(error),
              }),
          },
        )
      }
    >
      Reactivate
    </Button>
  );
}

function DeactivateButton({ templateId }: { templateId: string }) {
  const { show } = useToast();
  const deactivate = useDeactivateTemplate();

  return (
    <Button
      type="button"
      variant="tertiary"
      loading={deactivate.isPending}
      onClick={() =>
        deactivate.mutate(templateId, {
          onSuccess: () => show({ variant: "success", title: "Template deactivated" }),
          onError: (error) =>
            show({
              variant: "error",
              title: "Couldn't deactivate template",
              description: apiErrorDescription(error),
            }),
        })
      }
    >
      Deactivate
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
        ← Back to evaluations
      </Link>

      <div className="evaluations-list__header">
        <div>
          <h1>Criteria templates</h1>
          <p>Reusable scoring criteria for evaluation cycles.</p>
        </div>
        <Button type="button" variant="primary" onClick={openCreate}>
          New template
        </Button>
      </div>

      <Table caption="Evaluation criteria templates">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Title</Table.HeaderCell>
            <Table.HeaderCell>Max score</Table.HeaderCell>
            <Table.HeaderCell>Sort order</Table.HeaderCell>
            <Table.HeaderCell>Status</Table.HeaderCell>
            <Table.HeaderCell>Actions</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={templatesQuery.isPending}
          empty={
            templatesQuery.isError
              ? "Unable to load criteria templates."
              : "No criteria templates yet."
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
              <Table.Cell>{template.max_score}</Table.Cell>
              <Table.Cell>{template.sort_order}</Table.Cell>
              <Table.Cell>{template.is_active ? "Active" : "Inactive"}</Table.Cell>
              <Table.Cell>
                <div className="evaluations-detail__workflow-actions">
                  <Button type="button" variant="tertiary" onClick={() => openEdit(template)}>
                    Edit
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
