import { Chip, Select, Table } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import {
  studentDisplayName,
  useAllStudents,
  useClassesForTerm,
  useClassGradebook,
} from "../school/queries";
import { TermPicker, useTermSelection } from "../school/TermPicker";

import type { GradeSubmission } from "../school/queries";

import "../school/principal-school.css";

const STATUSES = ["draft", "submitted", "approved", "rejected", "published"] as const;
type SubmissionStatus = (typeof STATUSES)[number];

/** Assessment columns in the order they first appear, keyed by label (one label per assessment). */
function assessmentColumns(submissions: readonly GradeSubmission[]) {
  const columns = new Map<string, number>();
  for (const submission of submissions) {
    for (const grade of submission.grades) {
      if (!columns.has(grade.label)) columns.set(grade.label, grade.max_score);
    }
  }
  return [...columns].map(([label, maxScore]) => ({ label, maxScore }));
}

/** Weighted percentage over the assessments that have a score; null when nothing is graded yet. */
export function weightedAverage(submission: GradeSubmission): number | null {
  let earned = 0;
  let weight = 0;
  for (const grade of submission.grades) {
    if (grade.score === null || grade.max_score <= 0) continue;
    earned += (grade.score / grade.max_score) * grade.weight;
    weight += grade.weight;
  }
  return weight > 0 ? (earned / weight) * 100 : null;
}

/**
 * Grades overview (`/portal/principal/grades`): one class's gradebook for the chosen term, read-only
 * — scores per assessment, each student's weighted average, and where their submission sits in the
 * draft → submitted → approved/published workflow. Approving and rejecting happen on the shared
 * approvals queue, linked from the pending count.
 */
export default function PrincipalGradesPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const selection = useTermSelection();
  const classes = useClassesForTerm(selection.term?.id);
  const [pickedClassId, setPickedClassId] = useState<string>();

  const classList = [...(classes.data ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const klass = classList.find((candidate) => candidate.id === pickedClassId) ?? classList[0];
  const gradebook = useClassGradebook(klass?.id);
  const students = useAllStudents();

  const nameById = new Map((students.data ?? []).map((s) => [s.id, studentDisplayName(s)]));
  const submissions = [...(gradebook.data?.submissions ?? [])].sort((a, b) =>
    (nameById.get(a.student_id) ?? "").localeCompare(nameById.get(b.student_id) ?? ""),
  );
  const columns = assessmentColumns(submissions);
  const counts = new Map<SubmissionStatus, number>(STATUSES.map((status) => [status, 0]));
  for (const submission of submissions) {
    const status = submission.status as SubmissionStatus;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const pending = counts.get("submitted") ?? 0;

  return (
    <>
      <h1>{t("principal.grades.title")}</h1>
      <p>{t("principal.grades.description")}</p>

      <div className="principal-school__filters">
        <TermPicker selection={selection} />
        <Select
          label={t("principal.school.classLabel")}
          options={classList.map((candidate) => ({ value: candidate.id, label: candidate.code }))}
          value={klass?.id}
          onChange={setPickedClassId}
          placeholder={t("principal.school.noClasses")}
          disabled={classList.length === 0}
        />
      </div>

      {klass && (
        <div className="principal-school__summary">
          {STATUSES.map((status) => (
            <Chip key={status}>
              {t(`principal.grades.status.${status}`)}: {counts.get(status) ?? 0}
            </Chip>
          ))}
          {pending > 0 && (
            <Link to="/portal/approvals">
              {t("principal.grades.reviewPending", { count: pending })}
            </Link>
          )}
        </div>
      )}

      <Table caption={t("principal.grades.caption", { class: klass?.code ?? "" })}>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("principal.grades.columns.student")}</Table.HeaderCell>
            {columns.map((column) => (
              <Table.HeaderCell key={column.label}>
                {column.label} ({formatNumber(column.maxScore)})
              </Table.HeaderCell>
            ))}
            <Table.HeaderCell>{t("principal.grades.columns.average")}</Table.HeaderCell>
            <Table.HeaderCell>{t("principal.grades.columns.status")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={columns.length + 3}
          loading={selection.isPending || classes.isPending || gradebook.isPending}
          empty={
            gradebook.isError
              ? t("principal.grades.error")
              : klass
                ? t("principal.grades.empty")
                : t("principal.school.noClasses")
          }
        >
          {submissions.map((submission) => {
            const scores = new Map(submission.grades.map((grade) => [grade.label, grade.score]));
            const average = weightedAverage(submission);
            return (
              <Table.Row key={submission.id}>
                <Table.Cell>{nameById.get(submission.student_id) ?? "—"}</Table.Cell>
                {columns.map((column) => {
                  const score = scores.get(column.label);
                  return (
                    <Table.Cell key={column.label}>
                      {score === undefined || score === null ? "—" : formatNumber(score)}
                    </Table.Cell>
                  );
                })}
                <Table.Cell>
                  {average === null
                    ? "—"
                    : formatNumber(average / 100, { style: "percent", maximumFractionDigits: 1 })}
                </Table.Cell>
                <Table.Cell>{t(`principal.grades.status.${submission.status}`)}</Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </>
  );
}
