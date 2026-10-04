import { ApiError } from "@studafy/api-client";
import { Button, Table, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { DATE_TIME_OPTIONS } from "../format";

import { AddActionModal } from "./AddActionModal";
import {
  DISCIPLINE_ACTION_STATUS_LABEL_KEYS,
  DISCIPLINE_ACTION_TYPE_LABEL_KEYS,
  DISCIPLINE_SEVERITY_LABEL_KEYS,
  DISCIPLINE_STATUS_LABEL_KEYS,
  DISCIPLINE_TYPE_LABEL_KEYS,
  INCIDENT_STATUS_TRANSITIONS,
  INCIDENT_TRANSITION_LABEL_KEYS,
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

/** Toast copy per transition target — whole sentences, so each locale can word them naturally. */
const TRANSITION_TOAST_KEYS: Record<IncidentTransitionStatus, string> = {
  reported: "principal.discipline.detail.markedToast.reported",
  under_review: "principal.discipline.detail.markedToast.under_review",
  escalated: "principal.discipline.detail.markedToast.escalated",
  closed: "principal.discipline.detail.markedToast.closed",
};

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
  const { t } = useTranslation();
  const { formatDate: formatLocaleDate } = useFormatters();
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

  const formatDateTime = (iso: string) => formatLocaleDate(new Date(iso), DATE_TIME_OPTIONS);
  const formatDate = (isoDate: string | null) =>
    isoDate ? formatLocaleDate(new Date(isoDate)) : "—";

  const backLink = (
    <Link className="discipline-detail__back" to="/portal/principal/discipline">
      {t("principal.discipline.detail.back")}
    </Link>
  );

  if (incidentQuery.isPending) {
    return (
      <>
        {backLink}
        <p role="status">{t("principal.common.loading")}</p>
      </>
    );
  }

  if (incidentQuery.isError || !incidentQuery.data) {
    return (
      <>
        {backLink}
        <p role="alert">{t("principal.discipline.detail.loadError")}</p>
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
          title: t(TRANSITION_TOAST_KEYS[status]),
        }),
      onError: (error) =>
        show({
          variant: "error",
          title: t("principal.discipline.detail.updateFailed"),
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
          <dt>{t("principal.discipline.detail.type")}</dt>
          <dd>{t(DISCIPLINE_TYPE_LABEL_KEYS[incident.incident_type])}</dd>
        </div>
        <div>
          <dt>{t("principal.discipline.detail.severity")}</dt>
          <dd>
            <span className="discipline-severity-pill" data-tone={severityTone(incident.severity)}>
              {t(DISCIPLINE_SEVERITY_LABEL_KEYS[incident.severity])}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t("principal.discipline.detail.status")}</dt>
          <dd>{t(DISCIPLINE_STATUS_LABEL_KEYS[incident.status])}</dd>
        </div>
        <div>
          <dt>{t("principal.discipline.detail.reportedAt")}</dt>
          <dd>{formatDateTime(incident.incident_at)}</dd>
        </div>
        <div>
          <dt>{t("principal.discipline.detail.resolvedAt")}</dt>
          <dd>{incident.resolved_at ? formatDateTime(incident.resolved_at) : "—"}</dd>
        </div>
        <div>
          <dt>{t("principal.discipline.detail.parentVisibility")}</dt>
          <dd>
            {parentVisible
              ? t("principal.discipline.detail.visible")
              : incident.status === "resolved"
                ? t("principal.discipline.detail.notVisibleOff")
                : t("principal.discipline.detail.notVisibleYet")}
          </dd>
        </div>
      </dl>

      {incident.description ? <p>{incident.description}</p> : null}

      <section
        className="discipline-detail__section"
        aria-label={t("principal.discipline.detail.workflow")}
      >
        <h2>{t("principal.discipline.detail.workflow")}</h2>
        <div className="discipline-detail__workflow-actions">
          {transitionTargets.map((status) => (
            <Button
              key={status}
              type="button"
              variant="secondary"
              loading={updateStatus.isPending}
              onClick={() => handleTransition(status)}
            >
              {t(INCIDENT_TRANSITION_LABEL_KEYS[status] ?? "")}
            </Button>
          ))}
          {canResolve ? (
            <Button
              type="button"
              variant="primary"
              disabled={!hasActionRecord}
              onClick={() => setResolveOpen(true)}
            >
              {t("principal.discipline.detail.resolve")}
            </Button>
          ) : null}
        </div>
        {canResolve && !hasActionRecord ? (
          <p className="discipline-detail__hint">{t("principal.discipline.detail.resolveHint")}</p>
        ) : null}
      </section>

      <section
        className="discipline-detail__section"
        aria-label={t("principal.discipline.detail.actionsTaken")}
      >
        <div className="discipline-detail__actions-header">
          <h2>{t("principal.discipline.detail.actionsTaken")}</h2>
          <Button
            type="button"
            variant="secondary"
            disabled={!canAddAction}
            onClick={() => setAddActionOpen(true)}
          >
            {t("principal.discipline.detail.addAction")}
          </Button>
        </div>

        <Table caption={t("principal.discipline.detail.actionsCaption")}>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {t("principal.discipline.detail.actionColumns.type")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("principal.discipline.detail.actionColumns.status")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("principal.discipline.detail.actionColumns.details")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("principal.discipline.detail.actionColumns.effective")}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={ACTION_COLUMN_COUNT}
            loading={actionsQuery.isPending}
            empty={
              actionsQuery.isError
                ? t("principal.discipline.detail.actionsError")
                : t("principal.discipline.detail.actionsEmpty")
            }
          >
            {actions.map((action) => (
              <Table.Row key={action.id}>
                <Table.Cell>{t(DISCIPLINE_ACTION_TYPE_LABEL_KEYS[action.action_type])}</Table.Cell>
                <Table.Cell>{t(DISCIPLINE_ACTION_STATUS_LABEL_KEYS[action.status])}</Table.Cell>
                <Table.Cell>{action.description ?? "—"}</Table.Cell>
                <Table.Cell>
                  {action.effective_from
                    ? t("principal.discipline.detail.effectiveRange", {
                        from: formatDate(action.effective_from),
                        until: formatDate(action.effective_until),
                      })
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
