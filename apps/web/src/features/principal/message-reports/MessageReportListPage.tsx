import { Button, Select, Table } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { DATE_TIME_OPTIONS } from "../format";

import {
  MESSAGE_REPORT_FILTER_OPTION_KEYS,
  MESSAGE_REPORT_PRIORITY_LABEL_KEYS,
  MESSAGE_REPORT_REASON_LABEL_KEYS,
  MESSAGE_REPORT_ROLE_LABEL_KEYS,
  MESSAGE_REPORT_STATUS_LABEL_KEYS,
  priorityTone,
  statusTone,
} from "./labels";
import { fetchMessageReports, MESSAGE_REPORTS_PAGE_SIZE, messageReportListKey } from "./queries";

import type { MessageReportListFilter } from "./queries";
import type { SelectOption } from "@studafy/ui";

import "./message-reports.css";

const COLUMN_COUNT = 8;

/**
 * Message report review queue (`/portal/principal/message-reports`), gated on
 * `messageReport:review`. Lists parent ↔ teacher message reports in the server's triage order
 * (open first, then urgent / high / normal, then soonest `respond_by`), filterable by status and
 * paginated by offset. Each row links to `MessageReportDetailPage`, where the evidence transcript
 * and the review workflow live.
 */
export default function MessageReportListPage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const [filter, setFilter] = useState<MessageReportListFilter>("open");
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: messageReportListKey(filter, offset),
    queryFn: () => fetchMessageReports(filter, offset),
    placeholderData: keepPreviousData,
  });

  const reports = query.data?.reports ?? [];
  const total = query.data?.total ?? 0;
  const hasPreviousPage = offset > 0;
  const hasNextPage = offset + reports.length < total;

  const filterOptions: SelectOption<MessageReportListFilter>[] =
    MESSAGE_REPORT_FILTER_OPTION_KEYS.map(({ value, labelKey }) => ({
      value,
      label: t(labelKey),
    }));

  const formatDateTime = (iso: string) => formatDate(new Date(iso), DATE_TIME_OPTIONS);

  function handleFilterChange(next: MessageReportListFilter) {
    setFilter(next);
    setOffset(0);
  }

  return (
    <>
      <h1>{t("principal.messageReports.list.title")}</h1>
      <p>{t("principal.messageReports.list.description")}</p>

      <div className="message-reports__filter">
        <Select
          label={t("principal.messageReports.list.statusLabel")}
          options={filterOptions}
          value={filter}
          onChange={handleFilterChange}
        />
      </div>

      <Table caption={t("principal.messageReports.list.caption")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>
              {t("principal.messageReports.list.columns.priority")}
            </Table.HeaderCell>
            <Table.HeaderCell>{t("principal.messageReports.list.columns.reason")}</Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.messageReports.list.columns.reported")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.messageReports.list.columns.reporter")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.messageReports.list.columns.student")}
            </Table.HeaderCell>
            <Table.HeaderCell>
              {t("principal.messageReports.list.columns.createdAt")}
            </Table.HeaderCell>
            <Table.HeaderCell>{t("principal.messageReports.list.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.messageReports.list.columns.review")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={query.isPending}
          empty={
            query.isError
              ? t("principal.messageReports.list.error")
              : t("principal.messageReports.list.empty")
          }
        >
          {reports.map((report) => (
            <Table.Row key={report.id}>
              <Table.Cell>
                <div className="message-reports__priority">
                  <span className="message-reports__pill" data-tone={priorityTone(report.priority)}>
                    {t(MESSAGE_REPORT_PRIORITY_LABEL_KEYS[report.priority])}
                  </span>
                  {report.is_overdue ? (
                    <span className="message-reports__pill" data-tone="danger">
                      {t("principal.messageReports.overdue")}
                    </span>
                  ) : null}
                  <span
                    className="message-reports__respond-by"
                    data-overdue={report.is_overdue ? "true" : undefined}
                  >
                    {t("principal.messageReports.respondBy", {
                      time: formatDateTime(report.respond_by),
                    })}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>{t(MESSAGE_REPORT_REASON_LABEL_KEYS[report.reason_category])}</Table.Cell>
              <Table.Cell>
                {t("principal.messageReports.party", {
                  name: report.reported.name,
                  role: t(MESSAGE_REPORT_ROLE_LABEL_KEYS[report.reported.role]),
                })}
              </Table.Cell>
              <Table.Cell>
                {t("principal.messageReports.party", {
                  name: report.reporter.name,
                  role: t(MESSAGE_REPORT_ROLE_LABEL_KEYS[report.reporter.role]),
                })}
              </Table.Cell>
              <Table.Cell>{report.student.name}</Table.Cell>
              <Table.Cell>{formatDateTime(report.created_at)}</Table.Cell>
              <Table.Cell>
                <span className="message-reports__pill" data-tone={statusTone(report.status)}>
                  {t(MESSAGE_REPORT_STATUS_LABEL_KEYS[report.status])}
                </span>
              </Table.Cell>
              <Table.Cell>
                <Link
                  to={`/portal/principal/message-reports/${report.id}`}
                  aria-label={t("principal.messageReports.list.reviewLinkLabel", {
                    name: report.reported.name,
                  })}
                >
                  {t("principal.messageReports.list.reviewLink")}
                </Link>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {total > 0 ? (
        <div className="message-reports__pagination">
          <p className="message-reports__hint">
            {t("principal.messageReports.list.range", {
              from: formatNumber(offset + 1),
              to: formatNumber(offset + reports.length),
              total: formatNumber(total),
            })}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={!hasPreviousPage}
            onClick={() => setOffset(Math.max(0, offset - MESSAGE_REPORTS_PAGE_SIZE))}
          >
            {t("principal.messageReports.list.previous")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!hasNextPage}
            onClick={() => setOffset(offset + MESSAGE_REPORTS_PAGE_SIZE)}
          >
            {t("principal.messageReports.list.next")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
