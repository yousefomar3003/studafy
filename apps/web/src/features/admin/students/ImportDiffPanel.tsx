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

type PlacementConflict = NonNullable<StudentImportDiffRow["placement_conflict"]>;

const PLACEMENT_CONFLICT_KEYS: Readonly<Record<PlacementConflict, string>> = {
  NO_ACADEMIC_YEAR: "adminPeople.students.import.diff.placementConflicts.NO_ACADEMIC_YEAR",
  GRADE_NOT_FOUND: "adminPeople.students.import.diff.placementConflicts.GRADE_NOT_FOUND",
  SECTION_NOT_FOUND: "adminPeople.students.import.diff.placementConflicts.SECTION_NOT_FOUND",
  SECTION_REQUIRED: "adminPeople.students.import.diff.placementConflicts.SECTION_REQUIRED",
};

const FILTER_VALUES: readonly ActionFilter[] = ["all", "create", "update", "unchanged", "conflict"];

interface ParentOutcome {
  parent: StudentImportDiffRow["parent"];
  parent_conflict: StudentImportDiffRow["parent_conflict"];
  parent_group_line: number | null;
}

/** One parent's outcome as a sentence, or null when there is nothing to say. */
function describeParent(outcome: ParentOutcome, second: boolean, t: TFunction): string | null {
  switch (outcome.parent) {
    case "create":
      return second
        ? t("adminPeople.students.import.diff.newSecondParentAccount")
        : t("adminPeople.students.import.diff.newParentAccount");
    case "sibling":
      return t("adminPeople.students.import.diff.siblingParent", {
        line: outcome.parent_group_line,
      });
    case "conflict":
      return outcome.parent_conflict === "PARENT_EMAIL_IN_OTHER_FAMILY"
        ? t("adminPeople.students.import.diff.parentEmailInOtherFamily")
        : t("adminPeople.students.import.diff.parentAccountExists");
    default:
      return null;
  }
}

/** Where the student lands: "Grade 1 – A", or the grade alone when it has one section. */
function describePlacement(row: StudentImportDiffRow, t: TFunction): string | null {
  const where = row.section ? `${row.grade} – ${row.section}` : (row.grade ?? "");
  if (row.placement_conflict) {
    return t(PLACEMENT_CONFLICT_KEYS[row.placement_conflict], {
      grade: row.grade,
      section: row.section,
    });
  }
  if (row.placement === "place") return t("adminPeople.students.import.diff.placeIn", { where });
  if (row.placement === "move") return t("adminPeople.students.import.diff.moveTo", { where });
  return null;
}

/** What will happen to one row, as short sentences: the conflict reason, each field change, the
 * parent outcome (new, sibling of an earlier line, or not linked), and each template answer, with
 * a sensitive one shown only as its mask. */
function describeRow(row: StudentImportDiffRow, t: TFunction, language: string): string {
  if (row.conflict) return t(CONFLICT_MESSAGE_KEYS[row.conflict]);
  const parts = Object.entries(row.changes).map(([field, change]) =>
    t("adminPeople.students.import.diff.change", {
      field: fieldLabel(field as StudentImportField, t),
      from: change.from ?? t("adminPeople.students.import.diff.blank"),
      to: change.to,
    }),
  );
  if (row.parent === "kept" || row.parent2?.parent === "kept") {
    parts.push(t("adminPeople.students.import.diff.parentsKept"));
  }
  for (const [outcome, second] of [
    [row, false],
    [row.parent2, true],
  ] as const) {
    const sentence = outcome ? describeParent(outcome, second, t) : null;
    if (sentence) parts.push(sentence);
  }
  const placement = describePlacement(row, t);
  if (placement) parts.push(placement);
  for (const answer of row.records) {
    parts.push(
      t("adminPeople.students.import.diff.recordValue", {
        field: language.startsWith("ar") ? answer.label_ar : answer.label_en,
        value: answer.mask ?? formatValue(answer.value),
      }),
    );
  }
  return parts.join(t("adminPeople.students.import.diff.partSeparator"));
}

function formatValue(value: StudentImportDiffRow["records"][number]["value"]): string {
  if (Array.isArray(value)) return value.join(", ");
  return value === null ? "" : String(value);
}

interface ImportDiffPanelProps {
  record: StudentImport;
}

/**
 * The dry-run preview (`GET .../diff`): what confirming would do to live data right now. A preview,
 * not a reservation; the worker re-plans against live data when it runs.
 */
export function ImportDiffPanel({ record }: ImportDiffPanelProps) {
  const { t, i18n } = useTranslation();
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
              <div>
                <dt>{t("adminPeople.students.import.diff.stats.parentConflicts")}</dt>
                <dd>{diff.totals.parent_conflicts}</dd>
              </div>
              <div>
                <dt>{t("adminPeople.students.import.diff.stats.placed")}</dt>
                <dd>{diff.totals.placed}</dd>
              </div>
              <div>
                <dt>{t("adminPeople.students.import.diff.stats.placementConflicts")}</dt>
                <dd>{diff.totals.placement_conflicts}</dd>
              </div>
            </dl>

            {diff.totals.placement_conflicts > 0 ? (
              <p role="status" className="students-import__warning">
                {t("adminPeople.students.import.diff.placementConflictsBanner", {
                  count: diff.totals.placement_conflicts,
                })}
              </p>
            ) : null}

            {diff.totals.parent_conflicts > 0 ? (
              <p role="status" className="students-import__warning">
                {t("adminPeople.students.import.diff.parentConflictsBanner", {
                  count: diff.totals.parent_conflicts,
                })}
              </p>
            ) : null}

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
                  renderCell: (row: StudentImportDiffRow) => describeRow(row, t, i18n.language),
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
