import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ExportPanel } from "./ExportPanel";
import { REPORT_TYPE_DESCRIPTIONS, REPORT_TYPE_LABELS } from "./labels";
import { fetchArAgingReport } from "./queries";
import { ReportTable } from "./ReportTable";
import { StudentPickerField } from "./StudentPickerField";

import type { StudentProfile } from "../fees/queries";
import type { FormEvent } from "react";

/** Accounts Receivable Summary, aged into 30/60/90-day buckets. No required filters — an empty run
 * covers every household as of today. */
export default function ArAgingReportPanel() {
  const [reportDate, setReportDate] = useState("");
  const [student, setStudent] = useState<StudentProfile | null>(null);
  const [runId, setRunId] = useState(0);

  const query = useQuery({
    queryKey: ["finance", "reports", "ar-aging", "run", runId],
    queryFn: () =>
      fetchArAgingReport({
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
    <Card as="section" aria-label={REPORT_TYPE_LABELS.ar_aging}>
      <Card.Body>
        <p>{REPORT_TYPE_DESCRIPTIONS.ar_aging}</p>

        <form className="reports-panel__filters" onSubmit={handleSubmit}>
          <div className="sf-field">
            <label htmlFor="ar-aging-report-date">As of date (optional)</label>
            <input
              id="ar-aging-report-date"
              type="date"
              value={reportDate}
              onChange={(event) => setReportDate(event.target.value)}
            />
          </div>
          <StudentPickerField value={student} onChange={setStudent} />
          <Button type="submit" loading={query.isFetching}>
            Run report
          </Button>
        </form>

        <ReportTable
          hasRun={runId > 0}
          loading={query.isFetching}
          error={query.isError}
          report={query.data}
          caption="Accounts receivable aging results"
          idleMessage="Set filters (optional) and run the report to see aging balances."
        />

        <ExportPanel
          reportLabel={REPORT_TYPE_LABELS.ar_aging}
          buildRequest={(fileFormat) => ({
            report_type: "ar_aging",
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
