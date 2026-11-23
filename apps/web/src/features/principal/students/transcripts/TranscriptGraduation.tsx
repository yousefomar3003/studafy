import { useFormatters, useTranslation } from "../../../../lib/i18n";

import type { TranscriptContent } from "./queries";

type Requirements = NonNullable<TranscriptContent["graduation_requirements"]>;

/**
 * "Graduation requirements met" (or not met, or in progress) for each requirement set that applied
 * to the student, exactly as stored at issue. Transcripts issued before the line existed, or when no
 * set applied, have no `graduation_requirements` and show nothing here.
 */
export function TranscriptGraduation({
  requirements,
}: {
  requirements: Requirements | undefined | null;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  if (!requirements || requirements.length === 0) return null;

  return (
    <section className="ag-transcript__year" aria-labelledby="ag-transcript-graduation">
      <h3 id="ag-transcript-graduation" className="ag-transcript__year-title">
        {t("academicGrading.transcript.graduation.heading")}
      </h3>
      <ul className="ag-transcript__graduation">
        {requirements.map((requirement) => (
          <li key={requirement.name}>
            <strong>{requirement.name}:</strong>{" "}
            {t(`academicGrading.transcript.graduation.status.${requirement.status}`, {
              defaultValue: requirement.status,
            })}{" "}
            <span className="ag-muted">
              {t("academicGrading.transcript.graduation.rules", {
                met: formatNumber(requirement.rules_met),
                total: formatNumber(requirement.rules_total),
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
