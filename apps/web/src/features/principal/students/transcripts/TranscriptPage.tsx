import { Button } from "@studafy/ui";
import { useParams } from "react-router-dom";

import { usePortalBack } from "../../../../layouts/portal/PortalBackLink";
import { useFormatters, useTranslation } from "../../../../lib/i18n";
import {
  CourseLevel,
  CreditsEarned,
  DocumentRankFact,
  Num,
  Percent,
  QueryState,
  ResultValue,
  WeightedGpa,
} from "../../academic-setup/components";

import { useTranscript } from "./queries";
import { TranscriptExternalExams } from "./TranscriptExternalExams";
import { TranscriptGraduation } from "./TranscriptGraduation";

import type { TranscriptContent } from "./queries";

import "../../academic-setup/academic-setup.css";
import "./transcripts.css";

/**
 * A transcript exactly as issued, laid out for A4 printing. Everything shown comes from the
 * transcript's stored `content`, so a reprint always matches the original; a revoked or replaced
 * transcript says so on screen and on paper.
 */
export default function TranscriptPage() {
  const { t } = useTranslation();
  const { studentId, transcriptId } = useParams();
  const transcript = useTranscript(transcriptId);
  usePortalBack(`/portal/principal/students/${studentId ?? ""}`);

  return (
    <>
      <div className="ag-head ag-no-print">
        <Button type="button" onClick={() => window.print()} disabled={!transcript.data}>
          {t("academicGrading.transcript.print")}
        </Button>
      </div>
      <QueryState isPending={transcript.isPending} error={transcript.error}>
        {transcript.data ? (
          <>
            {transcript.data.status !== "issued" ? (
              <p className="ag-notice ag-certificate__void" role="note">
                {transcript.data.status === "revoked"
                  ? t("academicGrading.transcript.revoked", {
                      reason: transcript.data.revoke_reason ?? "—",
                    })
                  : t("academicGrading.transcript.superseded")}
              </p>
            ) : transcript.data.needs_reissue ? (
              <p className="ag-notice ag-no-print" role="note">
                {t("academicGrading.transcript.outdated")}
              </p>
            ) : null}
            <TranscriptDocument
              content={transcript.data.content}
              voided={transcript.data.status !== "issued"}
            />
          </>
        ) : null}
      </QueryState>
    </>
  );
}

/** Transcripts issued before credits existed have none: the column only appears when used. */
function yearHasCredits(year: TranscriptContent["years"][number]): boolean {
  return year.subjects.some((subject) => typeof subject.credits === "number");
}

export function TranscriptDocument({
  content,
  voided,
}: {
  content: TranscriptContent;
  voided: boolean;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const cumulative = content.cumulative;

  return (
    <article
      className={`ag-certificate ag-transcript${voided ? " ag-certificate--void" : ""}`}
      aria-labelledby="ag-transcript-title"
    >
      <header className="ag-certificate__header">
        <p className="ag-certificate__school">{content.school.name}</p>
        <h2 id="ag-transcript-title" className="ag-certificate__title">
          {t("academicGrading.transcript.title")}
        </h2>
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
          <dt>{t("academicGrading.certificate.serial")}</dt>
          <dd>{content.serial_number}</dd>
        </div>
        <div>
          <dt>{t("academicGrading.transcript.issueDate")}</dt>
          <dd>{formatDate(new Date(content.issued_at), { dateStyle: "long" })}</dd>
        </div>
      </dl>

      {content.years.map((year) => (
        <section
          key={year.academic_year.id}
          className="ag-transcript__year"
          aria-labelledby={`ag-transcript-year-${year.academic_year.id}`}
        >
          <h3
            id={`ag-transcript-year-${year.academic_year.id}`}
            className="ag-transcript__year-title"
          >
            {t("academicGrading.transcript.yearHeading", {
              year: year.academic_year.name,
              grade: year.grade_level_name,
              section: year.section_name,
            })}
          </h3>
          <table className="ag-certificate__table">
            <caption className="sf-visually-hidden">
              {t("academicGrading.transcript.yearCaption", { year: year.academic_year.name })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("academicGrading.certificate.subject")}</th>
                <th scope="col">{t("academicGrading.certificate.marks")}</th>
                <th scope="col">{t("academicGrading.certificate.percentage")}</th>
                <th scope="col">{t("academicGrading.certificate.grade")}</th>
                <th scope="col">{t("academicGrading.transcript.gpaPoints")}</th>
                <th scope="col">{t("academicGrading.transcript.weight")}</th>
                {yearHasCredits(year) ? (
                  <th scope="col">{t("academicGrading.credits.column")}</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {year.subjects.map((subject) => (
                <tr key={subject.code}>
                  <th scope="row">
                    {subject.name}
                    <CourseLevel level={subject.course_level} />
                    {subject.descriptive && !subject.exempt && (subject.skills?.length ?? 0) > 0 ? (
                      <ul className="ag-transcript__skills">
                        {subject.skills!.map((skill, index) => (
                          <li key={`${skill.name}-${index}`}>
                            {t("academicGrading.transcript.skillLine", {
                              skill: skill.name,
                              descriptor: skill.descriptor_label ?? "—",
                            })}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </th>
                  <td>
                    {subject.exempt ? (
                      t("academicGrading.certificate.exempt")
                    ) : subject.descriptive ? (
                      "—"
                    ) : (
                      <>
                        <Num value={subject.marks_obtained} /> / <Num value={subject.max_marks} />
                      </>
                    )}
                  </td>
                  <td>
                    {subject.exempt || subject.descriptive ? (
                      "—"
                    ) : (
                      <Percent value={subject.percentage} />
                    )}
                  </td>
                  <td>{subject.grade_label ?? "—"}</td>
                  <td>
                    {subject.descriptive ? (
                      "—"
                    ) : (
                      <>
                        <Num value={subject.gpa_points} />
                        <WeightedGpa value={subject.weighted_gpa_points} />
                      </>
                    )}
                  </td>
                  <td>
                    {subject.include_in_average ? <Num value={subject.average_weight} /> : "—"}
                  </td>
                  {yearHasCredits(year) ? (
                    <td>
                      <Num value={subject.credits} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="ag-certificate__facts ag-transcript__year-overall">
            <div>
              <dt>{t("academicGrading.certificate.average")}</dt>
              <dd>
                <ResultValue
                  display={year.overall.display}
                  percentage={year.overall.average_percentage}
                  weightedGpa={year.overall.weighted_gpa}
                />
              </dd>
            </div>
            {year.overall.credits_attempted == null ? null : (
              <div>
                <dt>{t("academicGrading.credits.label")}</dt>
                <dd>
                  <CreditsEarned
                    attempted={year.overall.credits_attempted}
                    earned={year.overall.credits_earned}
                  />
                </dd>
              </div>
            )}
            <DocumentRankFact rank={year.overall.class_rank} />
            <div>
              <dt>{t("academicGrading.certificate.overallGrade")}</dt>
              <dd>{year.overall.grade_label ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("academicGrading.certificate.outcome")}</dt>
              <dd>
                {t(`academicGrading.academicStatus.${year.overall.academic_status}`, {
                  defaultValue: year.overall.academic_status,
                })}
              </dd>
            </div>
          </dl>
        </section>
      ))}

      <dl className="ag-certificate__facts ag-certificate__overall">
        <div>
          <dt>{t("academicGrading.transcript.cumulativeAverage")}</dt>
          <dd>
            <strong>
              <Percent value={cumulative.average_percentage} />
            </strong>
          </dd>
        </div>
        <div>
          <dt>{t("academicGrading.transcript.cumulativeGpa")}</dt>
          <dd>
            <strong>{cumulative.gpa === null ? "—" : <Num value={cumulative.gpa} />}</strong>
            {cumulative.gpa === null ? null : <WeightedGpa value={cumulative.weighted_gpa} />}
          </dd>
        </div>
        {cumulative.credits_attempted == null ? null : (
          <div>
            <dt>{t("academicGrading.credits.cumulative")}</dt>
            <dd>
              <CreditsEarned
                attempted={cumulative.credits_attempted}
                earned={cumulative.credits_earned}
              />
            </dd>
          </div>
        )}
        <div>
          <dt>{t("academicGrading.transcript.yearsCovered")}</dt>
          <dd>
            <Num value={cumulative.years_covered} />
          </dd>
        </div>
      </dl>
      {cumulative.gpa === null && cumulative.gpa_unavailable_reason !== null ? (
        <p className="ag-muted">
          {t(`academicGrading.transcript.gpaReason.${cumulative.gpa_unavailable_reason}`, {
            subjects: cumulative.subjects_without_gpa_points.join(", "),
            scales: (cumulative.mixed_gpa_scales ?? [])
              .map((scale) =>
                t("academicGrading.transcript.gpaScale", {
                  year: scale.academic_year_name,
                  max: scale.max,
                }),
              )
              .join(", "),
          })}
        </p>
      ) : null}
      <p className="ag-muted">{t("academicGrading.transcript.method")}</p>

      <TranscriptExternalExams exams={content.external_exams} />

      <TranscriptGraduation requirements={content.graduation_requirements} />

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
            {t("academicGrading.transcript.reissueNote", {
              serial: content.reissue.supersedes_serial,
              reason: content.reissue.reason,
            })}
          </p>
        ) : null}
        <div className="ag-certificate__signatures">
          {(["principal", "stamp"] as const).map((role) => (
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
