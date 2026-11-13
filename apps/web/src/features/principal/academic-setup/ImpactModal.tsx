import { useFormatters, useTranslation } from "../../../lib/i18n";

import { Badge, ConfirmModal, QueryState } from "./components";
import { useConfigImpact } from "./queries";

import type { Term } from "../../admin/timetable/queries";

/**
 * Shown when a save comes back `ACADEMIC_CONFIG_IMPACT_UNCONFIRMED`: which sections' recorded marks
 * the change recalculates (those inheriting the configuration), which are untouched because they
 * override it (and become outdated), and which finalized results stay protected as they were.
 */
export function ImpactModal({
  configId,
  terms,
  submitting,
  onCancel,
  onConfirm,
}: {
  configId: string;
  terms: readonly Term[];
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const impact = useConfigImpact(configId);
  const termName = (termId: string | null) =>
    termId === null
      ? t("academicGrading.results.annual")
      : (terms.find((term) => term.id === termId)?.name ?? t("academicGrading.results.term"));

  return (
    <ConfirmModal
      open
      title={t("academicGrading.impact.title")}
      description={t("academicGrading.impact.description")}
      confirmLabel={t("academicGrading.impact.confirm")}
      submitting={submitting}
      confirmDisabled={!impact.data}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <QueryState isPending={impact.isPending} error={impact.error}>
        {impact.data ? (
          <div className="ag-impact">
            <p>
              <strong>
                {t("academicGrading.impact.marks", { count: impact.data.mark_count })}
              </strong>
            </p>

            <h3 className="ag-subheading">{t("academicGrading.impact.affected")}</h3>
            {impact.data.inheriting_sections.length === 0 ? (
              <p className="ag-muted">{t("academicGrading.impact.none")}</p>
            ) : (
              <ul className="ag-list">
                {impact.data.inheriting_sections.map((section) => (
                  <li key={section.section_id}>
                    {section.name}{" "}
                    <span className="ag-muted">
                      {t("academicGrading.impact.sectionMarks", {
                        count: section.mark_count,
                        formatted: formatNumber(section.mark_count),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {impact.data.is_grade_default ? (
              <>
                <h3 className="ag-subheading">{t("academicGrading.impact.notAffected")}</h3>
                {impact.data.overriding_sections.length === 0 ? (
                  <p className="ag-muted">{t("academicGrading.impact.none")}</p>
                ) : (
                  <ul className="ag-list">
                    {impact.data.overriding_sections.map((section) => (
                      <li key={section.section_id}>
                        {section.name}{" "}
                        <Badge tone={section.excluded ? "neutral" : "override"}>
                          {section.excluded
                            ? t("academicGrading.source.excluded")
                            : t("academicGrading.source.override")}
                        </Badge>{" "}
                        {section.excluded ? null : (
                          <span className="ag-muted">
                            {t("academicGrading.impact.willBeOutdated")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}

            <h3 className="ag-subheading">{t("academicGrading.impact.protected")}</h3>
            {impact.data.finalized_sections.length === 0 ? (
              <p className="ag-muted">{t("academicGrading.impact.none")}</p>
            ) : (
              <ul className="ag-list">
                {impact.data.finalized_sections.map((section) => (
                  <li key={`${section.section_id}-${section.term_id ?? "annual"}`}>
                    {section.name} — {termName(section.term_id)}
                  </li>
                ))}
              </ul>
            )}
            <p className="ag-muted">{t("academicGrading.impact.protectedHelp")}</p>
          </div>
        ) : null}
      </QueryState>
    </ConfirmModal>
  );
}
