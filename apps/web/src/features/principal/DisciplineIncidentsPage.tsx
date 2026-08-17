import { Select, Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../lib/api";

import {
  DISCIPLINE_SEVERITY_LABELS,
  DISCIPLINE_STATUS_LABELS,
  DISCIPLINE_TYPE_LABELS,
} from "./labels";
import { fetchOpenDisciplineIncidents } from "./queries";

import type { DisciplineIncident, DisciplineIncidentStatus } from "./queries";
import type { SelectOption } from "@studafy/ui";

const COLUMN_COUNT = 5;
const DETAIL_LIMIT = 100;

type StatusFilter = "open" | DisciplineIncidentStatus | "all";

const STATUS_FILTER_OPTIONS: SelectOption<StatusFilter>[] = [
  { value: "open", label: "Open (reported, under review, escalated)" },
  { value: "reported", label: DISCIPLINE_STATUS_LABELS.reported },
  { value: "under_review", label: DISCIPLINE_STATUS_LABELS.under_review },
  { value: "escalated", label: DISCIPLINE_STATUS_LABELS.escalated },
  { value: "resolved", label: DISCIPLINE_STATUS_LABELS.resolved },
  { value: "closed", label: DISCIPLINE_STATUS_LABELS.closed },
  { value: "all", label: "All statuses" },
];

async function fetchIncidents(filter: StatusFilter): Promise<DisciplineIncident[]> {
  if (filter === "open") {
    const { items } = await fetchOpenDisciplineIncidents(DETAIL_LIMIT);
    return items;
  }
  const { data } = await api.GET("/api/discipline/incidents", {
    params: {
      query: {
        limit: DETAIL_LIMIT,
        offset: 0,
        ...(filter === "all" ? {} : { status: filter }),
      },
    },
  });
  // `readonly DisciplineIncident[]` loses its array prototype through the generated response type
  // here — the same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents
  // for `notifications`. The annotation restores it without widening to `any`.
  return (data?.incidents ?? []) as DisciplineIncident[];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Discipline incident list (`/portal/principal/discipline`), drill-through target for the
 * principal dashboard's "Open discipline incidents" tile. Read-only, like `ApprovalsPage` — acting
 * on an incident (resolve, add an action) is the existing admin/teacher discipline workflow
 * (`apps/api/src/modules/discipline/routes/discipline-routes.ts`), not part of this dashboard.
 */
export default function DisciplineIncidentsPage() {
  const [filter, setFilter] = useState<StatusFilter>("open");

  const { data, isPending, isError } = useQuery({
    queryKey: ["discipline-incidents", "list", filter],
    queryFn: () => fetchIncidents(filter),
  });

  const incidents = data ?? [];

  return (
    <>
      <h1>Discipline incidents</h1>
      <p>Incidents reported across the school.</p>

      <Select
        label="Status"
        options={STATUS_FILTER_OPTIONS}
        value={filter}
        onChange={(value) => setFilter(value)}
      />

      <Table caption="Discipline incidents">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Title</Table.HeaderCell>
            <Table.HeaderCell>Type</Table.HeaderCell>
            <Table.HeaderCell>Severity</Table.HeaderCell>
            <Table.HeaderCell>Status</Table.HeaderCell>
            <Table.HeaderCell>Reported at</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={isPending}
          empty={
            isError ? "Unable to load discipline incidents." : "No incidents match this filter."
          }
        >
          {incidents.map((incident) => (
            <Table.Row key={incident.id}>
              <Table.Cell>{incident.title}</Table.Cell>
              <Table.Cell>{DISCIPLINE_TYPE_LABELS[incident.incident_type]}</Table.Cell>
              <Table.Cell>{DISCIPLINE_SEVERITY_LABELS[incident.severity]}</Table.Cell>
              <Table.Cell>{DISCIPLINE_STATUS_LABELS[incident.status]}</Table.Cell>
              <Table.Cell>{formatDate(incident.incident_at)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </>
  );
}
