import { Button, Card } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ExportPanel } from "./ExportPanel";
import { REPORT_TYPE_DESCRIPTIONS, REPORT_TYPE_LABELS } from "./labels";
import { fetchCollectionsVsDueReport } from "./queries";
import { ReportTable } from "./ReportTable";
import { StudentPickerField } from "./StudentPickerField";

import type { StudentProfile } from "../fees/queries";
import type { FormEvent } from "react";

/** ERPNext's "Accounts Receivable" report by payment term, with future payments visible — what's
 * been collected against what's due this term. Same optional-filter shape as
 * `ArAgingReportPanel`. */
export default function CollectionsVsDueReportPanel() {
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
    <Card as="section" aria-label={REPORT_TYPE_LABELS.collections_vs_due}>
      <Card.Body>
        <p>{REPORT_TYPE_DESCRIPTIONS.collections_vs_due}</p>

        <form className="reports-panel__filters" onSubmit={handleSubmit}>
          <div className="sf-field">
            <label htmlFor="collections-report-date">As of date (optional)</label>
            <input
              id="collections-report-date"
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
          caption="Collections vs due results"
          idleMessage="Set filters (optional) and run the report to see collections against what's due."
        />

        <ExportPanel
          reportLabel={REPORT_TYPE_LABELS.collections_vs_due}
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
