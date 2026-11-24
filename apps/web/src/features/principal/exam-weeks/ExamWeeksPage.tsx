import { Button, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { ConfirmModal } from "../academic-setup/components";
import { problemMessage } from "../academic-setup/errors";
import { pickCurrentYear, useAcademicYears } from "../school/queries";

import { formatDay } from "./format";
import { PeriodDetail } from "./PeriodDetail";
import { PeriodFormModal, PeriodStatusBadge } from "./PeriodForm";
import { useDeleteExamPeriod, useExamPeriods } from "./queries";
import { RoomsSection } from "./RoomsSection";

import type { YearRef } from "./PeriodForm";
import type { ExamPeriodSummary } from "./queries";

import "../school/principal-school.css";
import "../academic-setup/academic-setup.css";
import "./exam-weeks.css";

/**
 * Exam weeks (`/portal/principal/exam-weeks`), gated on `timetable:manage`: a year's exam periods
 * (midterms, finals...) and the school's rooms. Opening a period (`?period=`) shows its timetable,
 * seating, invigilators, clashes and the printed seating lists and door sheets. Students, parents
 * and invigilating teachers see a period in the app once it is published.
 */
export default function ExamWeeksPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const years = useAcademicYears();
  const yearList = years.data ?? [];
  const year = yearList.find((y) => y.id === params.get("year")) ?? pickCurrentYear(yearList);
  const periodId = params.get("period") ?? undefined;

  if (year && periodId) {
    return (
      <PeriodDetail periodId={periodId} year={year} onBack={() => setParams({ year: year.id })} />
    );
  }

  return (
    <>
      <div className="principal-school__header">
        <h1>{t("examWeeks.title")}</h1>
      </div>
      <p>{t("examWeeks.description")}</p>
      <div className="principal-school__filters">
        <Select
          label={t("examWeeks.yearLabel")}
          options={yearList.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
          value={year?.id}
          onChange={(id) => setParams({ year: id })}
          placeholder={t("examWeeks.noYears")}
          disabled={yearList.length === 0}
        />
      </div>
      {years.isPending ? (
        <p className="ag-muted" role="status">
          {t("examWeeks.loading")}
        </p>
      ) : years.isError ? (
        <p className="ag-error" role="alert">
          {problemMessage(years.error, t)}
        </p>
      ) : year ? (
        <PeriodsSection
          year={year}
          onOpen={(period) => setParams({ year: year.id, period: period.id })}
        />
      ) : (
        <p className="ag-muted">{t("examWeeks.noYears")}</p>
      )}
      <RoomsSection />
    </>
  );
}

function PeriodsSection({
  year,
  onOpen,
}: {
  year: YearRef;
  onOpen: (period: ExamPeriodSummary) => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const { formatDate, formatNumber } = useFormatters();
  const periods = useExamPeriods(year.id);
  const remove = useDeleteExamPeriod();
  const [editing, setEditing] = useState<{ period: ExamPeriodSummary | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExamPeriodSummary | null>(null);

  return (
    <section className="ag-block" aria-labelledby="ew-periods-heading">
      <div className="ag-head">
        <h2 id="ew-periods-heading">{t("examWeeks.periods.heading")}</h2>
        <Button type="button" variant="secondary" onClick={() => setEditing({ period: null })}>
          {t("examWeeks.periods.add")}
        </Button>
      </div>
      <p className="ag-muted">{t("examWeeks.periods.help")}</p>
      <Table caption={t("examWeeks.periods.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("examWeeks.periods.columns.name")}</Table.HeaderCell>
            <Table.HeaderCell>{t("examWeeks.periods.columns.dates")}</Table.HeaderCell>
            <Table.HeaderCell>{t("examWeeks.periods.columns.grades")}</Table.HeaderCell>
            <Table.HeaderCell>{t("examWeeks.periods.columns.exams")}</Table.HeaderCell>
            <Table.HeaderCell>{t("examWeeks.periods.columns.actions")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={5}
          loading={periods.isPending}
          empty={periods.isError ? problemMessage(periods.error, t) : t("examWeeks.periods.empty")}
        >
          {(periods.data ?? []).map((period) => (
            <Table.Row key={period.id}>
              <Table.Cell>
                <strong>{period.name}</strong>{" "}
                <span className="ag-muted">{t(`examWeeks.kinds.${period.kind}`)}</span>{" "}
                <PeriodStatusBadge status={period.status} />
              </Table.Cell>
              <Table.Cell>
                {formatDay(period.starts_on, formatDate)} – {formatDay(period.ends_on, formatDate)}
              </Table.Cell>
              <Table.Cell>{period.grade_levels.map((grade) => grade.name).join(", ")}</Table.Cell>
              <Table.Cell>{formatNumber(period.slot_count)}</Table.Cell>
              <Table.Cell>
                <div className="sections-page__row-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={t("examWeeks.periods.openLabel", { name: period.name })}
                    onClick={() => onOpen(period)}
                  >
                    {t("examWeeks.periods.open")}
                  </Button>
                  <Button
                    type="button"
                    variant="tertiary"
                    aria-label={t("examWeeks.periods.editLabel", { name: period.name })}
                    onClick={() => setEditing({ period })}
                  >
                    {t("examWeeks.common.edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="tertiary"
                    aria-label={t("examWeeks.periods.deleteLabel", { name: period.name })}
                    onClick={() => setPendingDelete(period)}
                  >
                    {t("examWeeks.common.delete")}
                  </Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {editing ? (
        <PeriodFormModal year={year} period={editing.period} onClose={() => setEditing(null)} />
      ) : null}
      <ConfirmModal
        open={pendingDelete !== null}
        title={t("examWeeks.periods.deleteTitle", { name: pendingDelete?.name ?? "" })}
        description={t("examWeeks.periods.deleteDescription")}
        confirmLabel={t("examWeeks.common.delete")}
        submitting={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSuccess: () => {
              show({ variant: "success", title: t("examWeeks.periods.deleted") });
              setPendingDelete(null);
            },
            onError: (error) => {
              show({
                variant: "error",
                title: t("examWeeks.periods.deleteFailed"),
                description: problemMessage(error, t),
              });
              setPendingDelete(null);
            },
          })
        }
      />
    </section>
  );
}
