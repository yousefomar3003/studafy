import { Select, Table, Tabs } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { DATE_TIME_OPTIONS } from "../format";

import {
  DISCIPLINE_SEVERITY_LABEL_KEYS,
  DISCIPLINE_STATUS_LABEL_KEYS,
  DISCIPLINE_TYPE_LABEL_KEYS,
} from "./labels";
import { disciplineListKey, fetchIncidentsByFilter } from "./queries";

import type { DisciplineIncident, IncidentListFilter } from "./queries";
import type { SelectOption } from "@studafy/ui";

import "./discipline.css";

const COLUMN_COUNT = 5;
const INBOX_TAB = "inbox";
const ALL_TAB = "all";

/** Filter options as translation keys — resolved with `t(...)` at render time. */
const ALL_FILTER_OPTION_KEYS: { value: IncidentListFilter; labelKey: string }[] = [
  { value: "open", labelKey: "principal.discipline.list.filterOpen" },
  { value: "reported", labelKey: DISCIPLINE_STATUS_LABEL_KEYS.reported },
  { value: "under_review", labelKey: DISCIPLINE_STATUS_LABEL_KEYS.under_review },
  { value: "escalated", labelKey: DISCIPLINE_STATUS_LABEL_KEYS.escalated },
  { value: "resolved", labelKey: DISCIPLINE_STATUS_LABEL_KEYS.resolved },
  { value: "closed", labelKey: DISCIPLINE_STATUS_LABEL_KEYS.closed },
  { value: "all", labelKey: "principal.discipline.list.filterAll" },
];

interface IncidentTableProps {
  incidents: DisciplineIncident[];
  isPending: boolean;
  isError: boolean;
  emptyMessage: string;
}

function IncidentTable({ incidents, isPending, isError, emptyMessage }: IncidentTableProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  return (
    <Table caption={t("principal.discipline.list.caption")}>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>{t("principal.discipline.list.columns.title")}</Table.HeaderCell>
          <Table.HeaderCell>{t("principal.discipline.list.columns.type")}</Table.HeaderCell>
          <Table.HeaderCell>{t("principal.discipline.list.columns.severity")}</Table.HeaderCell>
          <Table.HeaderCell>{t("principal.discipline.list.columns.status")}</Table.HeaderCell>
          <Table.HeaderCell>{t("principal.discipline.list.columns.reportedAt")}</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body
        columnCount={COLUMN_COUNT}
        loading={isPending}
        empty={isError ? t("principal.discipline.list.error") : emptyMessage}
      >
        {incidents.map((incident) => (
          <Table.Row key={incident.id}>
            <Table.Cell>
              <Link to={`/portal/principal/discipline/${incident.id}`}>{incident.title}</Link>
            </Table.Cell>
            <Table.Cell>{t(DISCIPLINE_TYPE_LABEL_KEYS[incident.incident_type])}</Table.Cell>
            <Table.Cell>{t(DISCIPLINE_SEVERITY_LABEL_KEYS[incident.severity])}</Table.Cell>
            <Table.Cell>{t(DISCIPLINE_STATUS_LABEL_KEYS[incident.status])}</Table.Cell>
            <Table.Cell>{formatDate(new Date(incident.incident_at), DATE_TIME_OPTIONS)}</Table.Cell>
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
  const { t } = useTranslation();
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

  const allFilterOptions: SelectOption<IncidentListFilter>[] = ALL_FILTER_OPTION_KEYS.map(
    ({ value, labelKey }) => ({ value, label: t(labelKey) }),
  );

  return (
    <>
      <h1>{t("principal.discipline.list.title")}</h1>
      <p>{t("principal.discipline.list.description")}</p>

      <Tabs defaultValue={INBOX_TAB} value={tab} onChange={setTab}>
        <div className="discipline-list__tabs">
          <Tabs.List>
            <Tabs.Tab value={INBOX_TAB}>{t("principal.discipline.list.inboxTab")}</Tabs.Tab>
            <Tabs.Tab value={ALL_TAB}>{t("principal.discipline.list.allTab")}</Tabs.Tab>
          </Tabs.List>
        </div>

        <Tabs.Panel value={INBOX_TAB}>
          <IncidentTable
            incidents={inbox.data ?? []}
            isPending={inbox.isPending}
            isError={inbox.isError}
            emptyMessage={t("principal.discipline.list.inboxEmpty")}
          />
        </Tabs.Panel>

        <Tabs.Panel value={ALL_TAB}>
          <div className="discipline-list__filter">
            <Select
              label={t("principal.discipline.list.statusLabel")}
              options={allFilterOptions}
              value={allFilter}
              onChange={setAllFilter}
            />
          </div>

          <IncidentTable
            incidents={all.data ?? []}
            isPending={all.isPending}
            isError={all.isError}
            emptyMessage={t("principal.discipline.list.filterEmpty")}
          />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
