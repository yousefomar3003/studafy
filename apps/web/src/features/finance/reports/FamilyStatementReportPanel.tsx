import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ExportPanel } from "./ExportPanel";
import { FamilyPickerField } from "./FamilyPickerField";
import { REPORT_TYPE_DESCRIPTIONS, REPORT_TYPE_LABELS } from "./labels";
import { fetchFamilyStatement } from "./queries";
import { ReportTable } from "./ReportTable";

import type { Family } from "./queries";
import type { FormEvent } from "react";

/** Household statement: the family's own accounts receivable aging plus its general ledger
 * activity, side by side. Unlike the other three reports, a family must be picked before a run
 * makes sense — there is no "every family" statement. */
export default function FamilyStatementReportPanel() {
  const [family, setFamily] = useState<Family | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [runId, setRunId] = useState(0);

  const query = useQuery({
    queryKey: ["finance", "reports", "family-statement", "run", runId],
    queryFn: () =>
      fetchFamilyStatement(family?.id ?? "", {
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      }),
    enabled: runId > 0 && family !== null,
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!family) return;
    setRunId((n) => n + 1);
  }

  return (
    <Card as="section" aria-label={REPORT_TYPE_LABELS.family_statement}>
      <Card.Body>
        <p>{REPORT_TYPE_DESCRIPTIONS.family_statement}</p>

        <form className="reports-panel__filters" onSubmit={handleSubmit}>
          <FamilyPickerField value={family} onChange={setFamily} />
          <div className="sf-field">
            <label htmlFor="family-statement-from-date">From date (optional)</label>
            <input
              id="family-statement-from-date"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </div>
          <div className="sf-field">
            <label htmlFor="family-statement-to-date">To date (optional)</label>
            <input
              id="family-statement-to-date"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
            />
          </div>
          <Button type="submit" loading={query.isFetching} disabled={!family}>
            Run report
          </Button>
        </form>

        {/* One status line for both halves of the statement, rather than `ReportTable`'s own
            idle/loading/error messaging duplicated per section — they always share one fetch, so
            there is never a case where one half is ready and the other isn't. */}
        {runId === 0 ? (
          <p role="status" className="reports-panel__idle">
            Pick a family and run the report to see its statement.
          </p>
        ) : query.isFetching ? (
          <p role="status" className="reports-panel__idle">
            Running report…
          </p>
        ) : query.isError || !query.data ? (
          <p role="alert" className="reports-panel__error">
            Unable to run this report. Please check your filters and try again.
          </p>
        ) : (
          <>
            <h3>Accounts receivable</h3>
            <ReportTable
              hasRun
              loading={false}
              error={false}
              report={query.data.accounts_receivable}
              caption="Family accounts receivable"
              idleMessage=""
            />

            <h3>General ledger activity</h3>
            <ReportTable
              hasRun
              loading={false}
              error={false}
              report={query.data.general_ledger}
              caption="Family general ledger"
              idleMessage=""
            />
          </>
        )}

        <ExportPanel
          reportLabel={REPORT_TYPE_LABELS.family_statement}
          buildRequest={(fileFormat) =>
            family
              ? {
                  report_type: "family_statement",
                  file_format: fileFormat,
                  parameters: {
                    family_id: family.id,
                    from_date: fromDate || undefined,
                    to_date: toDate || undefined,
                  },
                }
              : null
          }
          disabledReason="Pick a family to enable export."
        />
      </Card.Body>
    </Card>
  );
}
