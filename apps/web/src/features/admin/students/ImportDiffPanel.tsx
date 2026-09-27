import { Card, DataGrid, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { FIELD_LABELS } from "./columnMapping";
import { fetchStudentImportDiff, studentImportDiffQueryKey } from "./queries";

import type { StudentImport, StudentImportDiffRow } from "./queries";

type DiffAction = StudentImportDiffRow["action"];
type DiffConflict = NonNullable<StudentImportDiffRow["conflict"]>;
type ActionFilter = DiffAction | "all";

const ACTION_LABELS: Readonly<Record<DiffAction, string>> = {
  create: "New student",
  update: "Update",
  unchanged: "No change",
  conflict: "Skipped (conflict)",
};

const CONFLICT_MESSAGES: Readonly<Record<DiffConflict, string>> = {
  DUPLICATE_ADMISSION_NUMBER_IN_FILE:
    "An earlier line has the same admission number. The first line is imported.",
  DUPLICATE_EMAIL_IN_FILE: "An earlier line gives this email to a different admission number.",
  EMAIL_MISMATCH: "This student already exists and signs in with a different email.",
  EMAIL_BELONGS_TO_OTHER_STUDENT: "This email already belongs to another student.",
  EMAIL_BELONGS_TO_STAFF: "This email belongs to a staff account.",
  PARENT_EMAIL_BELONGS_TO_STUDENT: "The parent email belongs to a student.",
};

const FILTER_OPTIONS: readonly { value: ActionFilter; label: string }[] = [
  { value: "all", label: "All rows" },
  { value: "create", label: ACTION_LABELS.create },
  { value: "update", label: ACTION_LABELS.update },
  { value: "unchanged", label: ACTION_LABELS.unchanged },
  { value: "conflict", label: ACTION_LABELS.conflict },
];

/** What will happen to one row, as short sentences: the conflict reason, each field change, and
 * the parent account and link outcomes. */
function describeRow(row: StudentImportDiffRow): string {
  if (row.conflict) return CONFLICT_MESSAGES[row.conflict];
  const parts = Object.entries(row.changes).map(
    ([field, change]) =>
      `${FIELD_LABELS[field as keyof typeof row.changes]}: ${change.from ?? "(blank)"} → ${change.to}`,
  );
  if (row.parent === "create") parts.push("New parent account");
  if (row.link === "create") parts.push("New parent link");
  if (row.link === "update") parts.push("Parent link changes");
  return parts.join("; ");
}

interface ImportDiffPanelProps {
  record: StudentImport;
}

/**
 * The dry-run preview (`GET .../diff`): what confirming would do to live data right now. A preview,
 * not a reservation; the worker re-plans against live data when it runs.
 */
export function ImportDiffPanel({ record }: ImportDiffPanelProps) {
  const [filter, setFilter] = useState<ActionFilter>("all");
  const diffQuery = useQuery({
    queryKey: studentImportDiffQueryKey(record),
    queryFn: () => fetchStudentImportDiff(record.id),
  });

  const diff = diffQuery.data;
  const rows = diff
    ? (diff.rows as StudentImportDiffRow[]).filter(
        (row) => filter === "all" || row.action === filter,
      )
    : [];

  return (
    <Card as="section" aria-label="Import preview">
      <Card.Body>
        <h2 className="students-import__heading">Preview changes</h2>
        <p>
          What confirming would do to your student records right now. Nothing has been saved yet.
        </p>

        {diffQuery.isError ? (
          <p role="alert" className="students-import__banner">
            Couldn&apos;t load the preview. You can still confirm; the import is checked again when
            it runs.
          </p>
        ) : null}

        {diff ? (
          <>
            <dl className="students-import__stats">
              <div>
                <dt>New students</dt>
                <dd>{diff.totals.create}</dd>
              </div>
              <div>
                <dt>Updated students</dt>
                <dd>{diff.totals.update}</dd>
              </div>
              <div>
                <dt>No change</dt>
                <dd>{diff.totals.unchanged}</dd>
              </div>
              <div>
                <dt>Skipped (conflicts)</dt>
                <dd>{diff.totals.conflict}</dd>
              </div>
              <div>
                <dt>New parent accounts</dt>
                <dd>{diff.totals.parents_created}</dd>
              </div>
            </dl>

            <div className="students-import__diff-filter">
              <Select<ActionFilter>
                label="Show"
                options={FILTER_OPTIONS}
                value={filter}
                onChange={setFilter}
              />
            </div>

            <DataGrid
              caption="Changes per row"
              columns={[
                {
                  id: "line",
                  header: "Line",
                  renderCell: (row: StudentImportDiffRow) => row.line_number,
                  width: 80,
                },
                {
                  id: "admission_number",
                  header: "Admission number",
                  renderCell: (row: StudentImportDiffRow) => row.admission_number,
                  width: 180,
                },
                {
                  id: "action",
                  header: "Result",
                  renderCell: (row: StudentImportDiffRow) => ACTION_LABELS[row.action],
                  width: 180,
                },
                {
                  id: "details",
                  header: "Details",
                  renderCell: (row: StudentImportDiffRow) => describeRow(row),
                },
              ]}
              rows={rows}
              getRowId={(row) => String(row.line_number)}
              getRowLabel={(row) => `Line ${row.line_number}, ${row.admission_number}`}
              height={Math.min(480, 44 * Math.min(rows.length, 10) + 44)}
              empty="No rows match this filter."
            />
          </>
        ) : null}

        {diffQuery.isPending ? <p aria-live="polite">Loading preview…</p> : null}
      </Card.Body>
    </Card>
  );
}
