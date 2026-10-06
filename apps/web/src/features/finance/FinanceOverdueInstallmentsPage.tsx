import { Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";

import { ExportCsvButton } from "../../components/ExportCsvButton";
import { allRows } from "../../lib/data-transfer";
import { useTranslation } from "../../lib/i18n";

import {
  COLLECTIONS_VS_DUE_QUERY_KEY,
  fetchCollectionsVsDueReport,
  overdueInstallments,
  todayIsoDate,
} from "./queries";

import "./finance-dashboard.css";

import type { OverdueInstallment } from "./queries";
import type { ExportColumn } from "../../lib/data-transfer";

const COLUMN_COUNT = 4;

/** Matches `bucketForDaysOverdue` in `queries.ts` — the same 30/60/90 day boundaries the aging
 * chart's bars use, so a bucket clicked there lands on the matching filter here. */
const BUCKET_LABEL_KEYS: Readonly<Record<string, string>> = {
  range1: "finance.overdue.buckets.range1",
  range2: "finance.overdue.buckets.range2",
  range3: "finance.overdue.buckets.range3",
  range4: "finance.overdue.buckets.range4",
};

/**
 * Overdue installments (`/portal/finance/overdue`), drill-through target for the finance
 * dashboard's aging chart and overdue-installments tile (ST-200). `?bucket=` (set when an aging bar
 * is clicked) narrows the list to that day range client-side — the `collections-vs-due` report has
 * no server-side bucket filter, unlike `AttendanceByClassPage`'s `class_id`, so the full report is
 * fetched once and filtered here instead.
 */
export default function FinanceOverdueInstallmentsPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const bucket = searchParams.get("bucket") ?? undefined;

  const { data, isPending, isError } = useQuery({
    queryKey: COLLECTIONS_VS_DUE_QUERY_KEY,
    queryFn: fetchCollectionsVsDueReport,
  });

  const allInstallments = data ? overdueInstallments(data, todayIsoDate()) : [];
  const installments = (allInstallments ?? []).filter(
    (installment) => !bucket || installment.bucket === bucket,
  );
  // `bucket` comes from `?bucket=` and only ever indexes a display fallback (`?? bucket` itself)
  // into a fixed object literal — never used to read or write anything else.
  // eslint-disable-next-line security/detect-object-injection
  const bucketLabelKey = bucket ? BUCKET_LABEL_KEYS[bucket] : undefined;

  // Exports the rows on screen (the report is fetched whole), with the bucket filter applied.
  const exportColumns: ExportColumn<OverdueInstallment>[] = [
    { header: t("finance.overdue.columns.party"), value: (row) => row.partyName },
    { header: t("finance.overdue.columns.reference"), value: (row) => row.reference },
    { header: t("finance.overdue.columns.dueDate"), value: (row) => row.dueDate },
    { header: t("finance.overdue.columns.outstanding"), value: (row) => row.outstandingValue },
  ];

  return (
    <>
      <div className="finance-overdue__header">
        <div>
          <h1>{t("finance.overdue.title")}</h1>
          <p>{t("finance.overdue.intro")}</p>
        </div>
        <ExportCsvButton
          filename="overdue-installments"
          columns={exportColumns}
          getRows={() => Promise.resolve(allRows(installments))}
          disabled={isPending}
        />
      </div>

      {bucket ? (
        <p>
          {t("finance.overdue.filteredTo", {
            bucket: bucketLabelKey ? t(bucketLabelKey) : bucket,
          })}{" "}
          <Link to="/portal/finance/overdue">{t("finance.overdue.clearFilter")}</Link>
        </p>
      ) : null}

      <Table caption={t("finance.overdue.title")}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("finance.overdue.columns.party")}</Table.HeaderCell>
            <Table.HeaderCell>{t("finance.overdue.columns.reference")}</Table.HeaderCell>
            <Table.HeaderCell>{t("finance.overdue.columns.dueDate")}</Table.HeaderCell>
            <Table.HeaderCell>{t("finance.overdue.columns.outstanding")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={isPending}
          empty={
            isError
              ? t("finance.overdue.loadError")
              : allInstallments === null
                ? t("finance.overdue.missingColumns")
                : t("finance.overdue.empty")
          }
        >
          {installments.map((installment, index) => (
            <Table.Row key={`${installment.reference || installment.partyName}-${index}`}>
              <Table.Cell>{installment.partyName || "—"}</Table.Cell>
              <Table.Cell>{installment.reference || "—"}</Table.Cell>
              <Table.Cell>{installment.dueDate}</Table.Cell>
              <Table.Cell>{installment.outstandingDisplay}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </>
  );
}
