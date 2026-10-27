import { Button } from "@studafy/ui";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { Num, Percent, QueryState } from "./components";
import { setupHref } from "./context";
import { useCertificate } from "./queries";

import type { SetupContext } from "./context";
import type { CertificateContent } from "./queries";

/**
 * A certificate or report card exactly as issued: everything shown comes from the certificate's
 * stored `content`, never from current marks, so a reprint always matches the original. Revoked or
 * superseded certificates say so on screen and on paper.
 */
export function CertificateView({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { certificateId } = useParams();
  const certificate = useCertificate(certificateId);

  return (
    <>
      <div className="ag-head ag-no-print">
        <Link to={setupHref(ctx, "results")}>{t("academicGrading.certificate.back")}</Link>
        <Button type="button" onClick={() => window.print()} disabled={!certificate.data}>
          {t("academicGrading.certificate.print")}
        </Button>
      </div>
      <QueryState isPending={certificate.isPending} error={certificate.error}>
        {certificate.data ? (
          <>
            {certificate.data.status !== "issued" ? (
              <p className="ag-notice ag-certificate__void" role="note">
                {certificate.data.status === "revoked"
                  ? t("academicGrading.certificate.revoked", {
                      reason: certificate.data.revoke_reason ?? "—",
                    })
                  : t("academicGrading.certificate.superseded")}
              </p>
            ) : null}
            <CertificateDocument
              content={certificate.data.content}
              voided={certificate.data.status !== "issued"}
            />
          </>
        ) : null}
      </QueryState>
    </>
  );
}

export function CertificateDocument({
  content,
  voided,
}: {
  content: CertificateContent;
  voided: boolean;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  // Term columns, in the order the stored subjects list them (annual certificates only).
  const termColumns =
    content.kind === "annual_certificate"
      ? (content.subjects[0]?.terms ?? []).filter((term) => term.term_id !== null)
      : [];
  const title =
    content.kind === "annual_certificate"
      ? t("academicGrading.certificate.annualTitle")
      : t("academicGrading.certificate.termTitle", { term: content.term?.name ?? "" });

  return (
    <article
      className={`ag-certificate${voided ? " ag-certificate--void" : ""}`}
      aria-labelledby="ag-certificate-title"
    >
      <header className="ag-certificate__header">
        <p className="ag-certificate__school">{content.school.name}</p>
        <h2 id="ag-certificate-title" className="ag-certificate__title">
          {title}
        </h2>
        <p>{t("academicGrading.certificate.year", { year: content.academic_year.name })}</p>
      </header>

      <dl className="ag-certificate__facts">
        <div>
          <dt>{t("academicGrading.certificate.student")}</dt>
          <dd>
            {content.student.first_name} {content.student.last_name}
          </dd>
        </div>
        <div>
          <dt>{t("academicGrading.certificate.admission")}</dt>
          <dd>{content.student.admission_number}</dd>
        </div>
        <div>
          <dt>{t("academicGrading.certificate.class")}</dt>
          <dd>
            {t("academicGrading.certificate.gradeSection", {
              grade: content.grade_level_name,
              section: content.section_name,
            })}
          </dd>
        </div>
        <div>
          <dt>{t("academicGrading.certificate.serial")}</dt>
          <dd>{content.serial_number}</dd>
        </div>
      </dl>

      <table className="ag-certificate__table">
        <caption className="sf-visually-hidden">
          {t("academicGrading.certificate.subjectsCaption")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("academicGrading.certificate.subject")}</th>
            {termColumns.map((term) => (
              <th scope="col" key={term.term_id}>
                {term.term_name}
              </th>
            ))}
            <th scope="col">{t("academicGrading.certificate.marks")}</th>
            <th scope="col">{t("academicGrading.certificate.percentage")}</th>
            <th scope="col">{t("academicGrading.certificate.grade")}</th>
            <th scope="col">{t("academicGrading.certificate.result")}</th>
          </tr>
        </thead>
        <tbody>
          {content.subjects.map((subject) => (
            <tr key={subject.code}>
              <th scope="row">{subject.name}</th>
              {termColumns.map((column) => (
                <td key={column.term_id}>
                  <Percent
                    value={
                      subject.terms.find((term) => term.term_id === column.term_id)?.percentage
                    }
                  />
                </td>
              ))}
              <td>
                {subject.exempt ? (
                  "—"
                ) : (
                  <>
                    <Num value={subject.marks_obtained} /> / <Num value={subject.max_marks} />
                  </>
                )}
              </td>
              <td>{subject.exempt ? "—" : <Percent value={subject.percentage} />}</td>
              <td>{subject.grade_label ?? "—"}</td>
              <td>
                {subject.exempt
                  ? t("academicGrading.certificate.exempt")
                  : subject.passed === null
                    ? "—"
                    : subject.passed
                      ? t("academicGrading.certificate.pass")
                      : t("academicGrading.certificate.fail")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="ag-certificate__facts ag-certificate__overall">
        <div>
          <dt>{t("academicGrading.certificate.average")}</dt>
          <dd>
            <Percent value={content.overall.average_percentage} />
          </dd>
        </div>
        <div>
          <dt>{t("academicGrading.certificate.total")}</dt>
          <dd>
            {content.overall.total_obtained === null ? (
              "—"
            ) : (
              <>
                <Num value={content.overall.total_obtained} /> /{" "}
                <Num value={content.overall.total_max} />
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("academicGrading.certificate.overallGrade")}</dt>
          <dd>{content.overall.grade_label ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("academicGrading.certificate.failedSubjects")}</dt>
          <dd>
            <Num value={content.overall.subjects_failed} />
          </dd>
        </div>
        <div>
          <dt>{t("academicGrading.certificate.outcome")}</dt>
          <dd>
            <strong>
              {t(`academicGrading.academicStatus.${content.overall.academic_status}`, {
                defaultValue: content.overall.academic_status,
              })}
            </strong>
          </dd>
        </div>
      </dl>

      <footer className="ag-certificate__footer">
        <p>
          {t("academicGrading.certificate.issuedOn", {
            date: formatDate(new Date(content.issued_at), { dateStyle: "long" }),
          })}
          {content.issued_by.name
            ? ` — ${t("academicGrading.certificate.issuedBy", { name: content.issued_by.name })}`
            : null}
        </p>
        {content.reissue ? (
          <p className="ag-muted">
            {t("academicGrading.certificate.reissueNote", {
              serial: content.reissue.supersedes_serial,
              reason: content.reissue.reason,
            })}
          </p>
        ) : null}
        <div className="ag-certificate__signatures">
          {(["principal", "teacher", "stamp"] as const).map((role) => (
            <div key={role} className="ag-certificate__signature">
              <span className="ag-certificate__line" aria-hidden="true" />
              <span>{t(`academicGrading.certificate.signature.${role}`)}</span>
            </div>
          ))}
        </div>
      </footer>
    </article>
  );
}
