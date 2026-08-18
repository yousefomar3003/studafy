import { Table } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";

import {
  COLLECTIONS_VS_DUE_QUERY_KEY,
  fetchCollectionsVsDueReport,
  overdueInstallments,
  todayIsoDate,
} from "./queries";

const COLUMN_COUNT = 4;

/** Matches `bucketForDaysOverdue` in `queries.ts` — the same 30/60/90 day boundaries the aging
 * chart's bars use, so a bucket clicked there lands on the matching filter here. */
const BUCKET_LABELS: Readonly<Record<string, string>> = {
  range1: "0–30 days overdue",
  range2: "31–60 days overdue",
  range3: "61–90 days overdue",
  range4: "90+ days overdue",
};

/**
 * Overdue installments (`/portal/finance/overdue`), drill-through target for the finance
 * dashboard's aging chart and overdue-installments tile (ST-200). `?bucket=` (set when an aging bar
 * is clicked) narrows the list to that day range client-side — the `collections-vs-due` report has
 * no server-side bucket filter, unlike `AttendanceByClassPage`'s `class_id`, so the full report is
 * fetched once and filtered here instead.
 */
export default function FinanceOverdueInstallmentsPage() {
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

  return (
    <>
      <h1>Overdue installments</h1>
      <p>Installments past due with a balance still owed, from the collections vs due report.</p>

      {bucket ? (
        <p>
          {/* `bucket` comes from `?bucket=` and only ever indexes a display fallback (`?? bucket`
              itself) into a fixed object literal — never used to read or write anything else. */}
          {/* eslint-disable-next-line security/detect-object-injection */}
          Filtered to {BUCKET_LABELS[bucket] ?? bucket}.{" "}
          <Link to="/portal/finance/overdue">Clear filter</Link>
        </p>
      ) : null}

      <Table caption="Overdue installments">
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Party</Table.HeaderCell>
            <Table.HeaderCell>Reference</Table.HeaderCell>
            <Table.HeaderCell>Due date</Table.HeaderCell>
            <Table.HeaderCell>Outstanding</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={COLUMN_COUNT}
          loading={isPending}
          empty={
            isError
              ? "Unable to load the collections report."
              : allInstallments === null
                ? "The collections report didn't include the columns this needs."
                : "Nothing is overdue."
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
