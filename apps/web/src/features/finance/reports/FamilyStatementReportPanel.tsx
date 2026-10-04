import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { ExportPanel } from "./ExportPanel";
import { FamilyPickerField } from "./FamilyPickerField";
import { REPORT_TYPE_DESCRIPTION_KEYS, REPORT_TYPE_LABEL_KEYS } from "./labels";
import { fetchFamilyStatement } from "./queries";
import { ReportTable } from "./ReportTable";

import type { Family } from "./queries";
import type { FormEvent } from "react";

/** Household statement: the family's own accounts receivable aging plus its general ledger
 * activity, side by side. Unlike the other three reports, a family must be picked before a run
 * makes sense — there is no "every family" statement. */
export default function FamilyStatementReportPanel() {
  const { t } = useTranslation();
  const reportLabel = t(REPORT_TYPE_LABEL_KEYS.family_statement);
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
    <Card as="section" aria-label={reportLabel}>
      <Card.Body>
        <p>{t(REPORT_TYPE_DESCRIPTION_KEYS.family_statement)}</p>

        <form className="reports-panel__filters" onSubmit={handleSubmit}>
          <FamilyPickerField value={family} onChange={setFamily} />
          <div className="sf-field">
            <label htmlFor="family-statement-from-date">
              {t("financeReports.reports.filters.fromDateOptional")}
            </label>
            <input
              id="family-statement-from-date"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </div>
          <div className="sf-field">
            <label htmlFor="family-statement-to-date">
              {t("financeReports.reports.filters.toDateOptional")}
            </label>
            <input
              id="family-statement-to-date"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
            />
          </div>
          <Button type="submit" loading={query.isFetching} disabled={!family}>
            {t("financeReports.reports.filters.runReport")}
          </Button>
        </form>

        {/* One status line for both halves of the statement, rather than `ReportTable`'s own
            idle/loading/error messaging duplicated per section — they always share one fetch, so
            there is never a case where one half is ready and the other isn't. */}
        {runId === 0 ? (
          <p role="status" className="reports-panel__idle">
            {t("financeReports.reports.familyStatement.idle")}
          </p>
        ) : query.isFetching ? (
          <p role="status" className="reports-panel__idle">
            {t("financeReports.reports.table.running")}
          </p>
        ) : query.isError || !query.data ? (
          <p role="alert" className="reports-panel__error">
            {t("financeReports.reports.table.error")}
          </p>
        ) : (
          <>
            <h3>{t("financeReports.reports.familyStatement.accountsReceivable")}</h3>
            <ReportTable
              hasRun
              loading={false}
              error={false}
              report={query.data.accounts_receivable}
              caption={t("financeReports.reports.familyStatement.accountsReceivableCaption")}
              idleMessage=""
            />

            <h3>{t("financeReports.reports.familyStatement.generalLedger")}</h3>
            <ReportTable
              hasRun
              loading={false}
              error={false}
              report={query.data.general_ledger}
              caption={t("financeReports.reports.familyStatement.generalLedgerCaption")}
              idleMessage=""
            />
          </>
        )}

        <ExportPanel
          reportLabel={reportLabel}
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
          disabledReason={t("financeReports.reports.familyStatement.disabledReason")}
        />
      </Card.Body>
    </Card>
  );
}
