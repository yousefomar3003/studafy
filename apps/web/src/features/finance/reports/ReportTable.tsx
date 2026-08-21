import { DataGrid } from "@studafy/ui";

import { reportSummaryCards } from "../queries";

import { cellDisplay, columnAlign, reportColumns } from "./erp-report";

import type { FinanceReportResponse } from "../queries";
import type { DataGridColumn } from "@studafy/ui";

interface ReportRow {
  id: string;
  index: number;
}

export interface ReportTableProps {
  /** Whether "Run report" has been clicked at least once. Distinguishes "nothing run yet" from
   * "ran, zero rows came back" — both render nothing in `report`/`loading`, but they need different
   * empty-state copy (see this component's own doc comment). */
  hasRun: boolean;
  loading: boolean;
  error: boolean;
  report: FinanceReportResponse | undefined;
  caption: string;
  idleMessage: string;
}

/**
 * Renders any of the four report-center reports generically from ERPNext's own `columns`/`rows` —
 * Studafy does not know the shape of a given report ahead of time (see
 * `docs/modules/finance-reports-definitions.md`), so columns and cells are built entirely from what
 * the response describes, the same "render only what's known, never guess" rule
 * `finance/queries.ts`'s report-shape helpers already follow for the dashboard tiles.
 *
 * Three purpose-built empty states, not one generic "no data": before the first run, a prompt to
 * set filters and run; after a run with zero matching rows, `DataGrid`'s own empty state; on a
 * failed run, a retry-worthy error message. Conflating any two of these would tell the user the
 * wrong thing to do next.
 */
export function ReportTable({
  hasRun,
  loading,
  error,
  report,
  caption,
  idleMessage,
}: ReportTableProps) {
  if (!hasRun) {
    return (
      <p role="status" className="reports-panel__idle">
        {idleMessage}
      </p>
    );
  }

  if (loading) {
    return (
      <p role="status" className="reports-panel__idle">
        Running report…
      </p>
    );
  }

  if (error || !report) {
    return (
      <p role="alert" className="reports-panel__error">
        Unable to run this report. Please check your filters and try again.
      </p>
    );
  }

  const columns = reportColumns(report);
  const gridColumns: DataGridColumn<ReportRow>[] = columns.map((column, columnIndex) => ({
    id: column.fieldname ?? `col-${columnIndex}`,
    header: column.label ?? column.fieldname ?? `Column ${columnIndex + 1}`,
    align: columnAlign(column),
    renderCell: (row) => cellDisplay(report, row.index, column, columnIndex),
  }));
  const rows: ReportRow[] = report.rows.map((_, index) => ({ id: String(index), index }));
  const summary = reportSummaryCards(report);

  return (
    <div className="reports-panel__results" dir={report.presentation.direction}>
      {summary.length > 0 ? (
        <dl className="reports-panel__summary">
          {summary.map((card, index) => (
            <div key={`${card.label}-${index}`}>
              <dt>{card.label || "—"}</dt>
              <dd>{card.display}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <DataGrid
        caption={caption}
        columns={gridColumns}
        rows={rows}
        getRowId={(row) => row.id}
        empty="No records match these filters."
      />
    </div>
  );
}
