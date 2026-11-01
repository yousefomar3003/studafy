import { Button, Select, Table } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { AI_REPORT_STATUSES, aiPriorityTone, aiStatusTone } from "./labels";
import { useAiReports, useStudentNames } from "./queries";

import type { AiReportStatus } from "./queries";

import "../../principal/message-reports/message-reports.css";

const COLUMN_COUNT = 6;
const OPEN = "open";

/**
 * AI content moderation queue (`/portal/admin/ai-reports`), gated on `aiContent:moderate`
 * (ORG_ADMIN, the school's safeguarding lead): what students reported about AI answers, quizzes
 * and summaries, and what the safety filter escalated. Most urgent first, then soonest due; a
 * report still open past its deadline is flagged. The reported text itself is only on the detail
 * page, whose read is audit-logged.
 */
export default function AiReportsListPage() {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const [status, setStatus] = useState<AiReportStatus | typeof OPEN>(OPEN);
  const [page, setPage] = useState(0);
  const query = useAiReports(status === OPEN ? undefined : status, page);
  const reports = query.data?.reports ?? [];
  const names = useStudentNames(reports.map((report) => report.student_id));
  const total = query.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (query.data?.pageSize ?? 1)));

  const when = (iso: string) =>
    formatDate(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  return (
    <>
      <h1>{t("adminSchool.aiReports.title")}</h1>
      <p>{t("adminSchool.aiReports.description")}</p>

      <div className="message-reports__filter">
        <Select
          label={t("adminSchool.aiReports.filter")}
          options={[
            { value: OPEN, label: t("adminSchool.aiReports.openReports") },
            ...AI_REPORT_STATUSES.map((value) => ({
              value,
              label: t(`adminSchool.aiReports.status.${value}`),
            })),
          ]}
          value={status}
          onChange={(value) => {
            setStatus(value as AiReportStatus | typeof OPEN);
            setPage(0);
          }}
        />
      </div>

      <Table caption={t("adminSchool.aiReports.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("adminSchool.aiReports.columns.reason")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.aiReports.columns.priority")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.aiReports.columns.student")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.aiReports.columns.content")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.aiReports.columns.status")}</Table.HeaderCell>
            <Table.HeaderCell>{t("adminSchool.aiReports.columns.filed")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={query.isPending}
          empty={
            query.isError
              ? t("adminSchool.aiReports.loadError")
              : status === OPEN
                ? t("adminSchool.aiReports.emptyOpen")
                : t("adminSchool.aiReports.empty")
          }
        >
          {reports.map((report) => (
            <Table.Row key={report.id}>
              <Table.Cell>
                <Link to={`/portal/admin/ai-reports/${report.id}`}>
                  {t(`adminSchool.aiReports.reason.${report.reason_category}`)}
                </Link>
                <div className="message-reports__respond-by">
                  {t(`adminSchool.aiReports.source.${report.source}`)}
                </div>
              </Table.Cell>
              <Table.Cell>
                <div className="message-reports__priority">
                  <span
                    className="message-reports__pill"
                    data-tone={aiPriorityTone(report.priority)}
                  >
                    {t(`adminSchool.aiReports.priority.${report.priority}`)}
                  </span>
                  <span
                    className="message-reports__respond-by"
                    data-overdue={report.overdue ? "true" : undefined}
                  >
                    {report.overdue
                      ? t("adminSchool.aiReports.overdueSince", { time: when(report.respond_by) })
                      : t("adminSchool.aiReports.respondBy", { time: when(report.respond_by) })}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>{names.get(report.student_id) ?? "…"}</Table.Cell>
              <Table.Cell>
                {t(`adminSchool.aiReports.contentType.${report.content_type}`)}
              </Table.Cell>
              <Table.Cell>
                <span className="message-reports__pill" data-tone={aiStatusTone(report.status)}>
                  {t(`adminSchool.aiReports.status.${report.status}`)}
                </span>
              </Table.Cell>
              <Table.Cell>{when(report.created_at)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {pageCount > 1 ? (
        <div className="message-reports__pagination">
          <Button
            type="button"
            variant="tertiary"
            disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            {t("adminSchool.aiReports.previous")}
          </Button>
          <span className="message-reports__hint">
            {t("adminSchool.aiReports.pageOf", {
              page: formatNumber(page + 1),
              pages: formatNumber(pageCount),
            })}
          </span>
          <Button
            type="button"
            variant="tertiary"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((current) => current + 1)}
          >
            {t("adminSchool.aiReports.next")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
