import { ApiError } from "@studafy/api-client";
import { Button, Table, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { AddActionModal } from "./AddActionModal";
import {
  DISCIPLINE_ACTION_STATUS_LABELS,
  DISCIPLINE_ACTION_TYPE_LABELS,
  DISCIPLINE_SEVERITY_LABELS,
  DISCIPLINE_STATUS_LABELS,
  DISCIPLINE_TYPE_LABELS,
  INCIDENT_STATUS_TRANSITIONS,
  INCIDENT_TRANSITION_LABELS,
  severityTone,
} from "./labels";
import { useUpdateIncidentStatus } from "./mutations";
import {
  disciplineActionsKey,
  disciplineIncidentKey,
  fetchIncident,
  fetchIncidentActions,
  fetchParentDisciplineVisibility,
  PARENT_VISIBILITY_KEY,
} from "./queries";
import { ResolveIncidentModal } from "./ResolveIncidentModal";

import type { IncidentTransitionStatus } from "./mutations";
import type { DisciplineIncidentStatus } from "./queries";

import "./discipline.css";

const ACTION_COLUMN_COUNT = 4;

/** Statuses actions can still be added against — mirrors `createAction`'s own guard in
 * `apps/api/src/modules/discipline/discipline-service.ts` ("Cannot add actions to a resolved/closed
 * incident"), so the "Add action" button is never left enabled for a call the server would reject. */
const ACTION_LOCKED_STATUSES: readonly DisciplineIncidentStatus[] = ["resolved", "closed"];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDate(isoDate: string | null): string {
  return isoDate ? new Date(isoDate).toLocaleDateString() : "—";
}

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * Discipline incident detail (`/portal/principal/discipline/:incidentId`): full record, actions
 * taken, the parent-visibility flag, and the resolution workflow. Reachable from
 * `IncidentListPage`'s inbox and full list.
 *
 * Workflow buttons only ever offer a transition `INCIDENT_STATUS_TRANSITIONS` allows from the
 * current status (mirroring the server's own state machine), and the Resolve action stays disabled
 * until at least one action has been recorded — the acceptance criterion this screen exists to
 * satisfy, since the API itself does not enforce that requirement.
 */
export default function IncidentDetailPage() {
  const { incidentId = "" } = useParams<{ incidentId: string }>();
  const { show } = useToast();
  const [addActionOpen, setAddActionOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);

  const incidentQuery = useQuery({
    queryKey: disciplineIncidentKey(incidentId),
    queryFn: () => fetchIncident(incidentId),
  });
  const actionsQuery = useQuery({
    queryKey: disciplineActionsKey(incidentId),
    queryFn: () => fetchIncidentActions(incidentId),
  });
  const visibilityQuery = useQuery({
    queryKey: PARENT_VISIBILITY_KEY,
    queryFn: fetchParentDisciplineVisibility,
  });

  const updateStatus = useUpdateIncidentStatus(incidentId);

  const backLink = (
    <Link className="discipline-detail__back" to="/portal/principal/discipline">
      ← Back to discipline incidents
    </Link>
  );

  if (incidentQuery.isPending) {
    return (
      <>
        {backLink}
        <p role="status">Loading…</p>
      </>
    );
  }

  if (incidentQuery.isError || !incidentQuery.data) {
    return (
      <>
        {backLink}
        <p role="alert">Unable to load this discipline incident.</p>
      </>
    );
  }

  const incident = incidentQuery.data;
  const actions = actionsQuery.data ?? [];
  const hasActionRecord = actions.length > 0;
  const canAddAction = !ACTION_LOCKED_STATUSES.includes(incident.status);
  const canResolve = INCIDENT_STATUS_TRANSITIONS[incident.status].includes("resolved");
  const transitionTargets = INCIDENT_STATUS_TRANSITIONS[incident.status].filter(
    (status): status is IncidentTransitionStatus => status !== "resolved",
  );
  const parentVisible = incident.status === "resolved" && visibilityQuery.data === true;

  function handleTransition(status: IncidentTransitionStatus) {
    updateStatus.mutate(status, {
      onSuccess: () =>
        show({
          variant: "success",
          title: `Incident marked ${DISCIPLINE_STATUS_LABELS[status].toLowerCase()}`,
        }),
      onError: (error) =>
        show({
          variant: "error",
          title: "Couldn't update incident",
          description: apiErrorDescription(error),
        }),
    });
  }

  return (
    <>
      {backLink}

      <h1>{incident.title}</h1>

      <dl className="discipline-detail__summary">
        <div>
          <dt>Type</dt>
          <dd>{DISCIPLINE_TYPE_LABELS[incident.incident_type]}</dd>
        </div>
        <div>
          <dt>Severity</dt>
          <dd>
            <span className="discipline-severity-pill" data-tone={severityTone(incident.severity)}>
              {DISCIPLINE_SEVERITY_LABELS[incident.severity]}
            </span>
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{DISCIPLINE_STATUS_LABELS[incident.status]}</dd>
        </div>
        <div>
          <dt>Reported at</dt>
          <dd>{formatDateTime(incident.incident_at)}</dd>
        </div>
        <div>
          <dt>Resolved at</dt>
          <dd>{incident.resolved_at ? formatDateTime(incident.resolved_at) : "—"}</dd>
        </div>
        <div>
          <dt>Parent visibility</dt>
          <dd>
            {parentVisible
              ? "Visible to the student's parent"
              : incident.status === "resolved"
                ? "Not visible — parent discipline visibility is off for this school"
                : "Not visible yet — only resolved incidents can be shown to parents"}
          </dd>
        </div>
      </dl>

      {incident.description ? <p>{incident.description}</p> : null}

      <section className="discipline-detail__section" aria-label="Workflow">
        <h2>Workflow</h2>
        <div className="discipline-detail__workflow-actions">
          {transitionTargets.map((status) => (
            <Button
              key={status}
              type="button"
              variant="secondary"
              loading={updateStatus.isPending}
              onClick={() => handleTransition(status)}
            >
              {INCIDENT_TRANSITION_LABELS[status]}
            </Button>
          ))}
          {canResolve ? (
            <Button
              type="button"
              variant="primary"
              disabled={!hasActionRecord}
              onClick={() => setResolveOpen(true)}
            >
              Resolve
            </Button>
          ) : null}
        </div>
        {canResolve && !hasActionRecord ? (
          <p className="discipline-detail__hint">
            Record at least one disciplinary action before resolving this incident.
          </p>
        ) : null}
      </section>

      <section className="discipline-detail__section" aria-label="Actions taken">
        <div className="discipline-detail__actions-header">
          <h2>Actions taken</h2>
          <Button
            type="button"
            variant="secondary"
            disabled={!canAddAction}
            onClick={() => setAddActionOpen(true)}
          >
            Add action
          </Button>
        </div>

        <Table caption="Disciplinary actions taken">
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Type</Table.HeaderCell>
              <Table.HeaderCell>Status</Table.HeaderCell>
              <Table.HeaderCell>Details</Table.HeaderCell>
              <Table.HeaderCell>Effective</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={ACTION_COLUMN_COUNT}
            loading={actionsQuery.isPending}
            empty={
              actionsQuery.isError
                ? "Unable to load actions for this incident."
                : "No actions have been recorded yet."
            }
          >
            {actions.map((action) => (
              <Table.Row key={action.id}>
                <Table.Cell>{DISCIPLINE_ACTION_TYPE_LABELS[action.action_type]}</Table.Cell>
                <Table.Cell>{DISCIPLINE_ACTION_STATUS_LABELS[action.status]}</Table.Cell>
                <Table.Cell>{action.description ?? "—"}</Table.Cell>
                <Table.Cell>
                  {action.effective_from
                    ? `${formatDate(action.effective_from)} – ${formatDate(action.effective_until)}`
                    : "—"}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>

      <AddActionModal
        open={addActionOpen}
        incidentId={incidentId}
        onClose={() => setAddActionOpen(false)}
      />

      <ResolveIncidentModal
        open={resolveOpen}
        incidentId={incidentId}
        onClose={() => setResolveOpen(false)}
      />
    </>
  );
}
