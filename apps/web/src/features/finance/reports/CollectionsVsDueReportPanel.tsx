import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { ExportPanel } from "./ExportPanel";
import { REPORT_TYPE_DESCRIPTION_KEYS, REPORT_TYPE_LABEL_KEYS } from "./labels";
import { fetchCollectionsVsDueReport } from "./queries";
import { ReportTable } from "./ReportTable";
import { StudentPickerField } from "./StudentPickerField";

import type { StudentProfile } from "../fees/queries";
import type { FormEvent } from "react";

/** ERPNext's "Accounts Receivable" report by payment term, with future payments visible — what's
 * been collected against what's due this term. Same optional-filter shape as
 * `ArAgingReportPanel`. */
export default function CollectionsVsDueReportPanel() {
  const { t } = useTranslation();
  const reportLabel = t(REPORT_TYPE_LABEL_KEYS.collections_vs_due);
  const [reportDate, setReportDate] = useState("");
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [runId, setRunId] = useState(0);

  const query = useQuery({
    queryKey: ["finance", "reports", "collections-vs-due", "run", runId],
    queryFn: () =>
      fetchCollectionsVsDueReport({
        reportDate: reportDate || undefined,
        studentIds: student ? [student.id] : undefined,
      }),
    enabled: runId > 0,
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setRunId((n) => n + 1);
  }

  return (
    <Card as="section" aria-label={reportLabel}>
      <Card.Body>
        <p>{t(REPORT_TYPE_DESCRIPTION_KEYS.collections_vs_due)}</p>

        <form className="reports-panel__filters" onSubmit={handleSubmit}>
          <div className="sf-field">
            <label htmlFor="collections-report-date">
              {t("financeReports.reports.filters.asOfDateOptional")}
            </label>
            <input
              id="collections-report-date"
              type="date"
              value={reportDate}
              onChange={(event) => setReportDate(event.target.value)}
            />
          </div>
          <StudentPickerField value={student} onChange={setStudent} />
          <Button type="submit" loading={query.isFetching}>
            {t("financeReports.reports.filters.runReport")}
          </Button>
        </form>

        <ReportTable
          hasRun={runId > 0}
          loading={query.isFetching}
          error={query.isError}
          report={query.data}
          caption={t("financeReports.reports.collections.caption")}
          idleMessage={t("financeReports.reports.collections.idle")}
        />

        <ExportPanel
          reportLabel={reportLabel}
          buildRequest={(fileFormat) => ({
            report_type: "collections_vs_due",
            file_format: fileFormat,
            parameters: {
              report_date: reportDate || undefined,
              student_ids: student ? [student.id] : undefined,
            },
          })}
        />
      </Card.Body>
    </Card>
  );
}
