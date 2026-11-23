import { Select, Table } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useTerms } from "../school/queries";
import { useGradeLevels } from "../sections/queries";

import { QueryState, useOrdinal } from "./components";
import { setupHref } from "./context";
import { useGradePrograms, useTopStudents } from "./queries";

import type { SetupContext } from "./context";
import type { RankBasis, TopStudents } from "./queries";

const ANNUAL = "annual";
const LIMITS = [3, 5, 10, 20, 50] as const;

/**
 * The top students ("الأوائل") of a grade for a term or the whole year, by the class rank the grade
 * is set up with: one list for a grade-wide rank, one per section for a section rank. Every figure
 * is what the API computed from finalized results; ties share a place.
 */
export function TopStudentsTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const grades = useGradeLevels();
  const programs = useGradePrograms(ctx.year.id);
  const terms = useTerms(ctx.year.id);
  const [pickedGradeId, setPickedGradeId] = useState<string>();
  const [period, setPeriod] = useState<string>(ANNUAL);
  const [limit, setLimit] = useState<string>("10");

  // Only grades set up for the year can rank.
  const gradeList = (grades.data ?? []).filter((grade) =>
    programs.data?.some((program) => program.grade_level_id === grade.id),
  );
  const grade = gradeList.find((g) => g.id === pickedGradeId) ?? gradeList[0];
  const termList = [...(terms.data ?? [])].sort((a, b) => a.sequence_number - b.sequence_number);
  const termId = period === ANNUAL ? null : period;
  const top = useTopStudents(ctx.year.id, grade?.id, termId, Number(limit));

  return (
    <QueryState
      isPending={grades.isPending || programs.isPending || terms.isPending}
      error={grades.error ?? programs.error ?? terms.error}
      empty={gradeList.length === 0}
      emptyText={t("academicGrading.subjects.noGrades")}
    >
      <section className="ag-block" aria-labelledby="ag-top-students-heading">
        <h2 id="ag-top-students-heading">{t("academicGrading.topStudents.heading")}</h2>
        <p className="ag-muted">{t("academicGrading.topStudents.help")}</p>
        <div className="principal-school__filters">
          <Select
            label={t("academicGrading.topStudents.grade")}
            options={gradeList.map((g) => ({ value: g.id, label: g.name }))}
            value={grade?.id}
            onChange={setPickedGradeId}
          />
          <Select
            label={t("academicGrading.results.period")}
            options={[
              ...termList.map((term) => ({ value: term.id, label: term.name })),
              { value: ANNUAL, label: t("academicGrading.results.annual") },
            ]}
            value={period}
            onChange={setPeriod}
          />
          <Select
            label={t("academicGrading.topStudents.limit")}
            options={LIMITS.map((value) => ({ value: String(value), label: String(value) }))}
            value={limit}
            onChange={setLimit}
          />
        </div>
        {grade ? (
          <QueryState isPending={top.isPending} error={top.error}>
            {top.data ? <TopStudentsGroups ctx={ctx} data={top.data} /> : null}
          </QueryState>
        ) : null}
      </section>
    </QueryState>
  );
}

function TopStudentsGroups({ ctx, data }: { ctx: SetupContext; data: TopStudents }) {
  const { t } = useTranslation();
  if (!data.enabled) {
    return (
      <p className="ag-notice">
        {t("academicGrading.topStudents.disabled", { grade: data.grade_level_name })}{" "}
        <Link to={setupHref(ctx, "subjects")}>
          {t("academicGrading.topStudents.setUp", { grade: data.grade_level_name })}
        </Link>
      </p>
    );
  }
  return (
    <>
      <p className="ag-muted">
        {t("academicGrading.topStudents.rankedBy", {
          basis: t(`academicGrading.rank.basis.${data.basis}`),
        })}
      </p>
      {data.groups.map((group) => (
        <TopStudentsGroup
          key={group.section_id ?? "grade"}
          group={group}
          basis={data.basis}
          title={group.section_name ?? t("academicGrading.topStudents.gradeWide")}
          showSection={group.section_id === null}
        />
      ))}
    </>
  );
}

function TopStudentsGroup({
  group,
  basis,
  title,
  showSection,
}: {
  group: TopStudents["groups"][number];
  basis: RankBasis;
  title: string;
  showSection: boolean;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const ordinal = useOrdinal();
  const value = (n: number) =>
    basis === "average"
      ? formatNumber(n / 100, { style: "percent", maximumFractionDigits: 2 })
      : formatNumber(n, { maximumFractionDigits: 2 });
  return (
    <div className="ag-card ag-block">
      <h3 className="ag-subheading">{title}</h3>
      {group.status === "pending" ? (
        <p className="ag-notice">
          {t("academicGrading.topStudents.pending", {
            sections: group.pending_sections.map((section) => section.section_name).join(", "),
          })}
        </p>
      ) : (
        <>
          <p className="ag-muted">
            {t("academicGrading.topStudents.cohort", { count: group.cohort_size ?? 0 })}
          </p>
          <Table caption={t("academicGrading.topStudents.caption", { group: title })} hideCaption>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>{t("academicGrading.topStudents.columns.rank")}</Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.topStudents.columns.student")}
                </Table.HeaderCell>
                {showSection ? (
                  <Table.HeaderCell>
                    {t("academicGrading.topStudents.columns.section")}
                  </Table.HeaderCell>
                ) : null}
                <Table.HeaderCell>
                  {t("academicGrading.topStudents.columns.value")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("academicGrading.topStudents.columns.percentile")}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body
              columnCount={showSection ? 5 : 4}
              empty={t("academicGrading.topStudents.empty")}
            >
              {group.students.map((student) => (
                <Table.Row key={student.student_id}>
                  <Table.Cell>{ordinal(student.rank)}</Table.Cell>
                  <Table.Cell>
                    {student.first_name} {student.last_name}
                    <div className="ag-muted">{student.admission_number}</div>
                  </Table.Cell>
                  {showSection ? <Table.Cell>{student.section_name}</Table.Cell> : null}
                  <Table.Cell>
                    <bdi>{value(student.value)}</bdi>
                  </Table.Cell>
                  <Table.Cell>{ordinal(student.percentile)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </>
      )}
    </div>
  );
}
