import { Card, DataGrid, Select } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { fieldLabel } from "./columnMapping";
import { fetchStudentImportDiff, studentImportDiffQueryKey } from "./queries";

import type { StudentImportField } from "./columnMapping";
import type { StudentImport, StudentImportDiffRow } from "./queries";
import type { TFunction } from "i18next";

type DiffAction = StudentImportDiffRow["action"];
type DiffConflict = NonNullable<StudentImportDiffRow["conflict"]>;
type ActionFilter = DiffAction | "all";

const ACTION_LABEL_KEYS: Readonly<Record<DiffAction, string>> = {
  create: "adminPeople.students.import.diff.actions.create",
  update: "adminPeople.students.import.diff.actions.update",
  unchanged: "adminPeople.students.import.diff.actions.unchanged",
  conflict: "adminPeople.students.import.diff.actions.conflict",
};

const CONFLICT_MESSAGE_KEYS: Readonly<Record<DiffConflict, string>> = {
  DUPLICATE_ADMISSION_NUMBER_IN_FILE:
    "adminPeople.students.import.diff.conflicts.DUPLICATE_ADMISSION_NUMBER_IN_FILE",
  DUPLICATE_EMAIL_IN_FILE: "adminPeople.students.import.diff.conflicts.DUPLICATE_EMAIL_IN_FILE",
  EMAIL_MISMATCH: "adminPeople.students.import.diff.conflicts.EMAIL_MISMATCH",
  EMAIL_BELONGS_TO_OTHER_STUDENT:
    "adminPeople.students.import.diff.conflicts.EMAIL_BELONGS_TO_OTHER_STUDENT",
  EMAIL_BELONGS_TO_STAFF: "adminPeople.students.import.diff.conflicts.EMAIL_BELONGS_TO_STAFF",
  PARENT_EMAIL_BELONGS_TO_STUDENT:
    "adminPeople.students.import.diff.conflicts.PARENT_EMAIL_BELONGS_TO_STUDENT",
};

const FILTER_VALUES: readonly ActionFilter[] = ["all", "create", "update", "unchanged", "conflict"];

/** What will happen to one row, as short sentences: the conflict reason, each field change, and
 * the parent account and link outcomes. */
function describeRow(row: StudentImportDiffRow, t: TFunction): string {
  if (row.conflict) return t(CONFLICT_MESSAGE_KEYS[row.conflict]);
  const parts = Object.entries(row.changes).map(([field, change]) =>
    t("adminPeople.students.import.diff.change", {
      field: fieldLabel(field as StudentImportField, t),
      from: change.from ?? t("adminPeople.students.import.diff.blank"),
      to: change.to,
    }),
  );
  if (row.parent === "create") parts.push(t("adminPeople.students.import.diff.newParentAccount"));
  if (row.link === "create") parts.push(t("adminPeople.students.import.diff.newParentLink"));
  if (row.link === "update") parts.push(t("adminPeople.students.import.diff.parentLinkChanges"));
  return parts.join(t("adminPeople.students.import.diff.partSeparator"));
}

interface ImportDiffPanelProps {
  record: StudentImport;
}

/**
 * The dry-run preview (`GET .../diff`): what confirming would do to live data right now. A preview,
 * not a reservation; the worker re-plans against live data when it runs.
 */
export function ImportDiffPanel({ record }: ImportDiffPanelProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<ActionFilter>("all");
  const filterOptions = FILTER_VALUES.map((value) => ({
    value,
    label:
      value === "all"
        ? t("adminPeople.students.import.diff.allRows")
        : // eslint-disable-next-line security/detect-object-injection -- `value` comes from this module's own fixed `FILTER_VALUES` list
          t(ACTION_LABEL_KEYS[value]),
  }));
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
    <Card as="section" aria-label={t("adminPeople.students.import.diff.region")}>
      <Card.Body>
        <h2 className="students-import__heading">
          {t("adminPeople.students.import.diff.heading")}
        </h2>
        <p>{t("adminPeople.students.import.diff.intro")}</p>

        {diffQuery.isError ? (
          <p role="alert" className="students-import__banner">
            {t("adminPeople.students.import.diff.loadError")}
          </p>
        ) : null}

        {diff ? (
          <>
            <dl className="students-import__stats">
              <div>
                <dt>{t("adminPeople.students.import.diff.stats.newStudents")}</dt>
                <dd>{diff.totals.create}</dd>
              </div>
              <div>
                <dt>{t("adminPeople.students.import.diff.stats.updatedStudents")}</dt>
                <dd>{diff.totals.update}</dd>
              </div>
              <div>
                <dt>{t("adminPeople.students.import.diff.stats.noChange")}</dt>
                <dd>{diff.totals.unchanged}</dd>
              </div>
              <div>
                <dt>{t("adminPeople.students.import.diff.stats.skipped")}</dt>
                <dd>{diff.totals.conflict}</dd>
              </div>
              <div>
                <dt>{t("adminPeople.students.import.diff.stats.newParentAccounts")}</dt>
                <dd>{diff.totals.parents_created}</dd>
              </div>
            </dl>

            <div className="students-import__diff-filter">
              <Select<ActionFilter>
                label={t("adminPeople.students.import.diff.show")}
                options={filterOptions}
                value={filter}
                onChange={setFilter}
              />
            </div>

            <DataGrid
              caption={t("adminPeople.students.import.diff.caption")}
              columns={[
                {
                  id: "line",
                  header: t("adminPeople.students.import.diff.columns.line"),
                  renderCell: (row: StudentImportDiffRow) => row.line_number,
                  width: 80,
                },
                {
                  id: "admission_number",
                  header: t("adminPeople.students.import.diff.columns.admissionNumber"),
                  renderCell: (row: StudentImportDiffRow) => row.admission_number,
                  width: 180,
                },
                {
                  id: "action",
                  header: t("adminPeople.students.import.diff.columns.result"),
                  renderCell: (row: StudentImportDiffRow) => t(ACTION_LABEL_KEYS[row.action]),
                  width: 180,
                },
                {
                  id: "details",
                  header: t("adminPeople.students.import.diff.columns.details"),
                  renderCell: (row: StudentImportDiffRow) => describeRow(row, t),
                },
              ]}
              rows={rows}
              getRowId={(row) => String(row.line_number)}
              getRowLabel={(row) =>
                t("adminPeople.students.import.diff.rowLabel", {
                  line: row.line_number,
                  admissionNumber: row.admission_number,
                })
              }
              height={Math.min(480, 44 * Math.min(rows.length, 10) + 44)}
              empty={t("adminPeople.students.import.diff.empty")}
            />
          </>
        ) : null}

        {diffQuery.isPending ? (
          <p aria-live="polite">{t("adminPeople.students.import.diff.loading")}</p>
        ) : null}
      </Card.Body>
    </Card>
  );
}
