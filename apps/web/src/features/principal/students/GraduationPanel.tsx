import { Card } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { QueryState } from "../academic-setup/components";
import { useStudentGraduationChecklist } from "../academic-setup/graduation-requirements";
import { GraduationSetChecklist } from "../academic-setup/GraduationChecklist";

import "../academic-setup/academic-setup.css";

/**
 * A student's graduation requirements checklist on the principal's student page: every active set
 * that applies to the student (by grade level and year), each rule met, not met or in progress.
 * The sets are set up in Academic setup; nothing here is editable.
 */
export function GraduationPanel({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const checklist = useStudentGraduationChecklist(studentId);
  const data = checklist.data;

  return (
    <Card as="section" aria-labelledby="student-graduation-heading">
      <Card.Header>
        <h2 id="student-graduation-heading">{t("academicGrading.graduation.panel.heading")}</h2>
      </Card.Header>
      <Card.Body>
        <QueryState
          isPending={checklist.isPending}
          error={checklist.error}
          empty={data !== undefined && (data.sets ?? []).length === 0}
          emptyText={t("academicGrading.graduation.panel.empty")}
        >
          {data ? (
            <>
              <p className="ag-muted">
                {t("academicGrading.graduation.panel.basis", {
                  years: formatNumber(data.years_counted),
                })}
                {data.current_year_pending
                  ? ` ${t("academicGrading.graduation.currentYearPending")}`
                  : ""}
              </p>
              {data.sets.map((evaluation) => (
                <GraduationSetChecklist key={evaluation.set.id} evaluation={evaluation} />
              ))}
            </>
          ) : null}
        </QueryState>
      </Card.Body>
    </Card>
  );
}
