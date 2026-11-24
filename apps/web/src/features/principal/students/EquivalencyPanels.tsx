import { Card, Table } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { QueryState } from "../academic-setup/components";
import { useStudentEquivalency, useStudentMultiYearResults } from "../academic-setup/equivalency";
import {
  EquivalencyEstimateView,
  EstimateNotice,
  MultiYearStatusBadge,
} from "../academic-setup/EquivalencyBreakdown";

import "../academic-setup/academic-setup.css";

/**
 * A student's estimated Tawjihi-equivalent percentage on the principal's student page: every
 * active rule set for the student's grade level, step by step. An estimate under the school's own
 * rules, which the school confirms. The rules are set up in Academic setup; nothing here is editable.
 */
export function EquivalencyPanel({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const query = useStudentEquivalency(studentId);
  const data = query.data;

  return (
    <Card as="section" aria-labelledby="student-equivalency-heading">
      <Card.Header>
        <h2 id="student-equivalency-heading">{t("academicGrading.equivalency.panel.heading")}</h2>
      </Card.Header>
      <Card.Body>
        <QueryState
          isPending={query.isPending}
          error={query.error}
          empty={data !== undefined && (data.estimates ?? []).length === 0}
          emptyText={t("academicGrading.equivalency.panel.empty")}
        >
          {data ? (
            <>
              <EstimateNotice />
              {(data.estimates ?? []).map((estimate) => (
                <EquivalencyEstimateView
                  key={estimate.set.id}
                  estimate={estimate}
                  heading={estimate.set.name}
                />
              ))}
            </>
          ) : null}
        </QueryState>
      </Card.Body>
    </Card>
  );
}

/**
 * A student's multi-year results: each year's finalized figure and, once every year is finalized,
 * the weighted result per subject and overall.
 */
export function MultiYearPanel({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const query = useStudentMultiYearResults(studentId);
  const data = query.data;
  const percent = (value: number | null) =>
    value === null ? "—" : `${formatNumber(value, { maximumFractionDigits: 2 })}%`;

  return (
    <Card as="section" aria-labelledby="student-multi-year-heading">
      <Card.Header>
        <h2 id="student-multi-year-heading">{t("academicGrading.multiYear.panel.heading")}</h2>
      </Card.Header>
      <Card.Body>
        <QueryState
          isPending={query.isPending}
          error={query.error}
          empty={data !== undefined && (data.results ?? []).length === 0}
          emptyText={t("academicGrading.multiYear.panel.empty")}
        >
          {(data?.results ?? []).map((result) => (
            <div key={result.config.id} className="ag-card">
              <div className="ag-head">
                <h3>{result.config.name}</h3>
                <MultiYearStatusBadge status={result.status} />
              </div>
              <p>
                <strong>
                  {result.overall_percentage === null
                    ? t(`academicGrading.multiYear.statusHelp.${result.status}`)
                    : t("academicGrading.multiYear.overall", {
                        value: percent(result.overall_percentage),
                      })}
                </strong>
              </p>
              <Table
                caption={t("academicGrading.multiYear.subjectsCaption", {
                  name: result.config.name,
                })}
                hideCaption
              >
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>
                      {t("academicGrading.multiYear.columns.subject")}
                    </Table.HeaderCell>
                    {result.years.map((year) => (
                      <Table.HeaderCell key={year.grade_level.id}>
                        {t("academicGrading.multiYear.yearHeader", {
                          grade: year.grade_level.name,
                          share: formatNumber(year.share, { maximumFractionDigits: 2 }),
                        })}
                      </Table.HeaderCell>
                    ))}
                    <Table.HeaderCell>
                      {t("academicGrading.multiYear.columns.weighted")}
                    </Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body columnCount={result.years.length + 2}>
                  <Table.Row>
                    <Table.Cell>
                      <strong>{t("academicGrading.multiYear.overallRow")}</strong>
                    </Table.Cell>
                    {result.years.map((year) => (
                      <Table.Cell key={year.grade_level.id}>
                        {year.status === "finalized"
                          ? percent(year.overall_percentage)
                          : t(`academicGrading.multiYear.yearStatus.${year.status}`)}
                        {year.academic_year ? (
                          <span className="ag-muted"> ({year.academic_year.name})</span>
                        ) : null}
                      </Table.Cell>
                    ))}
                    <Table.Cell>
                      <strong>{percent(result.overall_percentage)}</strong>
                    </Table.Cell>
                  </Table.Row>
                  {result.subjects.map((subject) => (
                    <Table.Row key={subject.subject_id}>
                      <Table.Cell>{subject.name || subject.code}</Table.Cell>
                      {subject.by_year.map((entry) => (
                        <Table.Cell key={entry.grade_level_id}>
                          {percent(entry.percentage)}
                        </Table.Cell>
                      ))}
                      <Table.Cell>{percent(subject.percentage)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          ))}
        </QueryState>
      </Card.Body>
    </Card>
  );
}
