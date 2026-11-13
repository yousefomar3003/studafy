import { useFormatters, useTranslation } from "../../../lib/i18n";

import { conductLabel } from "./report-cards";

import type { CertificateContent } from "./queries";

/**
 * The report card notes printed on a certificate or term report: subject teachers' comments,
 * conduct, attendance, and the class teacher's and principal's comments, exactly as frozen when
 * the results were finalized. Renders nothing for certificates issued before report card notes.
 */
export function ReportNotesBlock({ content }: { content: CertificateContent }) {
  const { t, i18n } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const report = content.report;
  const subjectComments = content.subjects.filter((subject) => subject.comment);
  if (!report && subjectComments.length === 0) return null;
  const date = (value: string) =>
    formatDate(new Date(`${value}T00:00:00`), { dateStyle: "medium" });

  return (
    <section
      className="ag-certificate__notes"
      aria-label={t("academicGrading.certificate.notesLabel")}
    >
      {subjectComments.length > 0 ? (
        <div className="ag-certificate__note">
          <h3>{t("academicGrading.certificate.subjectComments")}</h3>
          <dl className="ag-certificate__comments">
            {subjectComments.map((subject) => (
              <div key={subject.code}>
                <dt>{subject.name}</dt>
                <dd>{subject.comment}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {report?.conduct || report?.attendance ? (
        <dl className="ag-certificate__facts">
          {report.conduct ? (
            <div>
              <dt>{t("academicGrading.certificate.conduct")}</dt>
              <dd>{conductLabel(report.conduct, i18n.language)}</dd>
            </div>
          ) : null}
          {report.attendance ? (
            <>
              <div>
                <dt>{t("academicGrading.certificate.daysPresent")}</dt>
                <dd>{formatNumber(report.attendance.days_present)}</dd>
              </div>
              <div>
                <dt>{t("academicGrading.certificate.daysAbsent")}</dt>
                <dd>{formatNumber(report.attendance.days_absent)}</dd>
              </div>
              <div>
                <dt>{t("academicGrading.certificate.daysLate")}</dt>
                <dd>{formatNumber(report.attendance.days_late)}</dd>
              </div>
              <div>
                <dt>{t("academicGrading.certificate.daysExcused")}</dt>
                <dd>{formatNumber(report.attendance.days_excused)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      ) : null}
      {report?.attendance ? (
        <p className="ag-muted">
          {t("academicGrading.certificate.attendancePeriod", {
            from: date(report.attendance.from),
            to: date(report.attendance.to),
            days: formatNumber(report.attendance.days_recorded),
          })}
        </p>
      ) : null}

      {report?.teacher_comment ? (
        <div className="ag-certificate__note">
          <h3>{t("academicGrading.certificate.teacherComment")}</h3>
          <p>{report.teacher_comment}</p>
        </div>
      ) : null}
      {report?.principal_comment ? (
        <div className="ag-certificate__note">
          <h3>{t("academicGrading.certificate.principalComment")}</h3>
          <p>{report.principal_comment}</p>
        </div>
      ) : null}
    </section>
  );
}
