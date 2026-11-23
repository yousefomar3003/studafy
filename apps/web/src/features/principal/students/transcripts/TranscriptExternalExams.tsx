import { useFormatters, useTranslation } from "../../../../lib/i18n";

import type { TranscriptContent } from "./queries";

type ExternalExams = NonNullable<TranscriptContent["external_exams"]>;

/**
 * A transcript's "External examinations" section (SAT, IELTS, IGCSE finals...), exactly as stored
 * at issue. Transcripts issued before the section existed, or for a student without any, have no
 * `external_exams` and show nothing here.
 */
export function TranscriptExternalExams({ exams }: { exams: ExternalExams | undefined | null }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  if (!exams || exams.length === 0) return null;
  const format = (value: number) => formatNumber(value, { maximumFractionDigits: 2 });

  return (
    <section className="ag-transcript__year" aria-labelledby="ag-transcript-external-exams">
      <h3 id="ag-transcript-external-exams" className="ag-transcript__year-title">
        {t("academicGrading.transcript.externalExams.heading")}
      </h3>
      <table className="ag-certificate__table">
        <caption className="sf-visually-hidden">
          {t("academicGrading.transcript.externalExams.heading")}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("academicGrading.transcript.externalExams.exam")}</th>
            <th scope="col">{t("academicGrading.transcript.externalExams.date")}</th>
            <th scope="col">{t("academicGrading.transcript.externalExams.scores")}</th>
            <th scope="col">{t("academicGrading.transcript.externalExams.total")}</th>
          </tr>
        </thead>
        <tbody>
          {exams.flatMap((exam) =>
            exam.results.map((result, index) => (
              <tr key={`${exam.code}-${index}`}>
                <th scope="row">
                  {result.subject
                    ? t("academicGrading.transcript.externalExams.examSubject", {
                        exam: exam.name,
                        subject: result.subject.name,
                      })
                    : exam.name}
                </th>
                <td>
                  {formatDate(new Date(`${result.sat_on}T00:00:00`), { dateStyle: "medium" })}
                </td>
                <td>
                  {result.scores
                    .map((score) =>
                      t("academicGrading.transcript.externalExams.scoreLine", {
                        component: score.component,
                        score:
                          score.numeric_score !== null
                            ? format(score.numeric_score)
                            : (score.label_score ?? "—"),
                      }),
                    )
                    .join(" · ")}
                </td>
                <td>
                  {result.total_score === null
                    ? "—"
                    : exam.total_max !== null
                      ? t("academicGrading.transcript.externalExams.outOf", {
                          score: format(result.total_score),
                          max: format(exam.total_max),
                        })
                      : format(result.total_score)}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </section>
  );
}
