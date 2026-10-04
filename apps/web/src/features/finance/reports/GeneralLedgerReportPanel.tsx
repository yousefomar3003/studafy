import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { ExportPanel } from "./ExportPanel";
import { REPORT_TYPE_DESCRIPTION_KEYS, REPORT_TYPE_LABEL_KEYS } from "./labels";
import { fetchGeneralLedgerReport } from "./queries";
import { ReportTable } from "./ReportTable";
import { StudentPickerField } from "./StudentPickerField";

import type { StudentProfile } from "../fees/queries";
import type { FormEvent } from "react";

/** ERPNext's General Ledger, filtered to a date range that's required (there is no useful "every
 * posting ever" default for a ledger) plus optional account/voucher/student narrowing. */
export default function GeneralLedgerReportPanel() {
  const { t } = useTranslation();
  const reportLabel = t(REPORT_TYPE_LABEL_KEYS.general_ledger);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [account, setAccount] = useState("");
  const [voucherNo, setVoucherNo] = useState("");
  const [voucherType, setVoucherType] = useState("");
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [runId, setRunId] = useState(0);

  const canRun = fromDate !== "" && toDate !== "";

  const query = useQuery({
    queryKey: ["finance", "reports", "general-ledger", "run", runId],
    queryFn: () =>
      fetchGeneralLedgerReport({
        fromDate,
        toDate,
        studentIds: student ? [student.id] : undefined,
        account: account || undefined,
        voucherNo: voucherNo || undefined,
        voucherType: voucherType || undefined,
      }),
    enabled: runId > 0 && canRun,
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canRun) return;
    setRunId((n) => n + 1);
  }

  return (
    <Card as="section" aria-label={reportLabel}>
      <Card.Body>
        <p>{t(REPORT_TYPE_DESCRIPTION_KEYS.general_ledger)}</p>

        <form className="reports-panel__filters" onSubmit={handleSubmit}>
          <div className="sf-field">
            <label htmlFor="gl-from-date">{t("financeReports.reports.filters.fromDate")}</label>
            <input
              id="gl-from-date"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              required
            />
          </div>
          <div className="sf-field">
            <label htmlFor="gl-to-date">{t("financeReports.reports.filters.toDate")}</label>
            <input
              id="gl-to-date"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              required
            />
          </div>
          <div className="sf-field">
            <label htmlFor="gl-account">
              {t("financeReports.reports.filters.accountOptional")}
            </label>
            <input
              id="gl-account"
              type="text"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              maxLength={255}
            />
          </div>
          <div className="sf-field">
            <label htmlFor="gl-voucher-no">
              {t("financeReports.reports.filters.voucherNoOptional")}
            </label>
            <input
              id="gl-voucher-no"
              type="text"
              value={voucherNo}
              onChange={(event) => setVoucherNo(event.target.value)}
              maxLength={255}
            />
          </div>
          <div className="sf-field">
            <label htmlFor="gl-voucher-type">
              {t("financeReports.reports.filters.voucherTypeOptional")}
            </label>
            <input
              id="gl-voucher-type"
              type="text"
              value={voucherType}
              onChange={(event) => setVoucherType(event.target.value)}
              maxLength={255}
            />
          </div>
          <StudentPickerField value={student} onChange={setStudent} />
          <Button type="submit" loading={query.isFetching} disabled={!canRun}>
            {t("financeReports.reports.filters.runReport")}
          </Button>
        </form>

        <ReportTable
          hasRun={runId > 0}
          loading={query.isFetching}
          error={query.isError}
          report={query.data}
          caption={t("financeReports.reports.generalLedger.caption")}
          idleMessage={t("financeReports.reports.generalLedger.idle")}
        />

        <ExportPanel
          reportLabel={reportLabel}
          buildRequest={(fileFormat) =>
            canRun
              ? {
                  report_type: "general_ledger",
                  file_format: fileFormat,
                  parameters: {
                    from_date: fromDate,
                    to_date: toDate,
                    student_ids: student ? [student.id] : undefined,
                    account: account || undefined,
                    voucher_no: voucherNo || undefined,
                    voucher_type: voucherType || undefined,
                  },
                }
              : null
          }
          disabledReason={t("financeReports.reports.generalLedger.disabledReason")}
        />
      </Card.Body>
    </Card>
  );
}
