import { Select, Table, Tabs } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import {
  DISCIPLINE_SEVERITY_LABELS,
  DISCIPLINE_STATUS_LABELS,
  DISCIPLINE_TYPE_LABELS,
} from "./labels";
import { disciplineListKey, fetchIncidentsByFilter } from "./queries";

import type { DisciplineIncident, IncidentListFilter } from "./queries";
import type { SelectOption } from "@studafy/ui";

import "./discipline.css";

const COLUMN_COUNT = 5;
const INBOX_TAB = "inbox";
const ALL_TAB = "all";

const ALL_FILTER_OPTIONS: SelectOption<IncidentListFilter>[] = [
  { value: "open", label: "Open (reported, under review, escalated)" },
  { value: "reported", label: DISCIPLINE_STATUS_LABELS.reported },
  { value: "under_review", label: DISCIPLINE_STATUS_LABELS.under_review },
  { value: "escalated", label: DISCIPLINE_STATUS_LABELS.escalated },
  { value: "resolved", label: DISCIPLINE_STATUS_LABELS.resolved },
  { value: "closed", label: DISCIPLINE_STATUS_LABELS.closed },
  { value: "all", label: "All statuses" },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface IncidentTableProps {
  incidents: DisciplineIncident[];
  isPending: boolean;
  isError: boolean;
  emptyMessage: string;
}

function IncidentTable({ incidents, isPending, isError, emptyMessage }: IncidentTableProps) {
  return (
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
        empty={isError ? "Unable to load discipline incidents." : emptyMessage}
      >
        {incidents.map((incident) => (
          <Table.Row key={incident.id}>
            <Table.Cell>
              <Link to={`/portal/principal/discipline/${incident.id}`}>{incident.title}</Link>
            </Table.Cell>
            <Table.Cell>{DISCIPLINE_TYPE_LABELS[incident.incident_type]}</Table.Cell>
            <Table.Cell>{DISCIPLINE_SEVERITY_LABELS[incident.severity]}</Table.Cell>
            <Table.Cell>{DISCIPLINE_STATUS_LABELS[incident.status]}</Table.Cell>
            <Table.Cell>{formatDate(incident.incident_at)}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

/**
 * Discipline incident list (`/portal/principal/discipline`), drill-through target for the
 * principal dashboard's "Open discipline incidents" tile. Two tabs share one table and one fetch
 * path (`fetchIncidentsByFilter`):
 *
 * - Inbox: freshly teacher-reported incidents (`status: "reported"`) awaiting principal triage —
 *   the "teacher-reported incidents inbox".
 * - All incidents: the full list with a status filter, including the dashboard's merged "open"
 *   view.
 *
 * A row's title links to `IncidentDetailPage`, where severity, actions taken, and the
 * resolve/escalate workflow live.
 */
export default function IncidentListPage() {
  const [tab, setTab] = useState<string>(INBOX_TAB);
  const [allFilter, setAllFilter] = useState<IncidentListFilter>("open");

  const inbox = useQuery({
    queryKey: disciplineListKey("reported"),
    queryFn: () => fetchIncidentsByFilter("reported"),
  });

  const all = useQuery({
    queryKey: disciplineListKey(allFilter),
    queryFn: () => fetchIncidentsByFilter(allFilter),
  });

  return (
    <>
      <h1>Discipline incidents</h1>
      <p>Incidents reported across the school.</p>

      <Tabs defaultValue={INBOX_TAB} value={tab} onChange={setTab}>
        <div className="discipline-list__tabs">
          <Tabs.List>
            <Tabs.Tab value={INBOX_TAB}>Teacher-reported inbox</Tabs.Tab>
            <Tabs.Tab value={ALL_TAB}>All incidents</Tabs.Tab>
          </Tabs.List>
        </div>

        <Tabs.Panel value={INBOX_TAB}>
          <IncidentTable
            incidents={inbox.data ?? []}
            isPending={inbox.isPending}
            isError={inbox.isError}
            emptyMessage="No incidents are waiting for triage."
          />
        </Tabs.Panel>

        <Tabs.Panel value={ALL_TAB}>
          <div className="discipline-list__filter">
            <Select
              label="Status"
              options={ALL_FILTER_OPTIONS}
              value={allFilter}
              onChange={setAllFilter}
            />
          </div>

          <IncidentTable
            incidents={all.data ?? []}
            isPending={all.isPending}
            isError={all.isError}
            emptyMessage="No incidents match this filter."
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
