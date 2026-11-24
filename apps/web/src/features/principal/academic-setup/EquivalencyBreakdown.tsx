import { Table } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { Badge } from "./components";

import type { BadgeTone } from "./components";
import type {
  EquivalencyEstimate,
  EquivalencyIssue,
  EquivalencyStatus,
  MultiYearStatus,
} from "./equivalency";
import type { TFunction } from "i18next";

const STATUS_TONE: Record<EquivalencyStatus, BadgeTone> = {
  estimated: "success",
  incomplete: "warning",
  not_eligible: "danger",
};

/** Estimated, Missing data or No estimate. */
export function EquivalencyStatusBadge({ status }: { status: EquivalencyStatus }) {
  const { t } = useTranslation();
  // eslint-disable-next-line security/detect-object-injection -- `status` is the closed EquivalencyStatus union
  const tone = STATUS_TONE[status] ?? "neutral";
  return <Badge tone={tone}>{t(`academicGrading.equivalency.status.${status}`)}</Badge>;
}

const MULTI_YEAR_TONE: Record<MultiYearStatus, BadgeTone> = {
  complete: "success",
  pending: "warning",
  incomplete: "danger",
};

export function MultiYearStatusBadge({ status }: { status: MultiYearStatus }) {
  const { t } = useTranslation();
  // eslint-disable-next-line security/detect-object-injection -- `status` is the closed MultiYearStatus union
  const tone = MULTI_YEAR_TONE[status] ?? "neutral";
  return <Badge tone={tone}>{t(`academicGrading.multiYear.status.${status}`)}</Badge>;
}

/** The estimate notice every equivalency figure carries. */
export function EstimateNotice() {
  const { t } = useTranslation();
  return (
    <p className="ag-notice" role="note">
      {t("academicGrading.equivalency.estimateNotice")}
    </p>
  );
}

/** One missing-data reason or note, in words: "Required subject missing: Arabic". */
export function equivalencyIssueText(
  issue: EquivalencyIssue,
  parts: readonly { label: string }[],
  t: TFunction,
  format: (value: number) => string,
): string {
  const part = issue.part_index === null ? "" : (parts.at(issue.part_index)?.label ?? "");
  const text = t(`academicGrading.equivalency.issue.${issue.code}`, {
    defaultValue: t("academicGrading.equivalency.issue.unknown"),
    subject: issue.subject?.name ?? "",
    exam: issue.exam?.name ?? "",
    grade: issue.grade ?? "",
    required: issue.required === null ? "" : format(issue.required),
    actual: issue.actual === null ? "" : format(issue.actual),
  });
  return part ? `${part}: ${text}` : text;
}

/**
 * An estimate step by step: its status and percentage, each part (its percentage and share of the
 * estimate, the value converted or the subjects counted) and why anything is missing.
 */
export function EquivalencyEstimateView({
  estimate,
  heading,
}: {
  estimate: Pick<EquivalencyEstimate, "status" | "percentage" | "parts" | "issues">;
  heading: string;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const format = (value: number) => formatNumber(value, { maximumFractionDigits: 2 });
  const percent = (value: number | null) => (value === null ? "—" : `${format(value)}%`);

  return (
    <div className="ag-card">
      <div className="ag-head">
        <h3>{heading}</h3>
        <EquivalencyStatusBadge status={estimate.status} />
      </div>
      <p>
        <strong>
          {estimate.percentage === null
            ? t("academicGrading.equivalency.noFigure")
            : t("academicGrading.equivalency.estimated", { value: percent(estimate.percentage) })}
        </strong>
      </p>
      <Table caption={t("academicGrading.equivalency.partsCaption", { name: heading })} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.equivalency.columns.part")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.equivalency.columns.basis")}</Table.HeaderCell>
            <Table.HeaderCell>
              {t("academicGrading.equivalency.columns.percentage")}
            </Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.equivalency.columns.share")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={4}>
          {estimate.parts.map((part) => (
            <Table.Row key={part.index}>
              <Table.Cell>
                <strong>{part.label}</strong>{" "}
                <span className="ag-muted">
                  {t(`academicGrading.equivalency.partStatus.${part.status}`)}
                </span>
              </Table.Cell>
              <Table.Cell>
                {part.type === "exam_subjects" ? (
                  <ul className="ag-issues">
                    {part.subjects.map((step) => (
                      <li key={`${step.subject.id}-${step.exam.id}-${step.grade}`}>
                        {t("academicGrading.equivalency.subjectStep", {
                          subject: step.subject.name || step.subject.id,
                          grade: step.grade,
                          value: percent(step.percentage),
                        })}{" "}
                        {step.counted ? (
                          <Badge tone="info">
                            {step.required_subject
                              ? t("academicGrading.equivalency.requiredCounted")
                              : t("academicGrading.equivalency.counted")}
                          </Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : part.source_value === null ? (
                  "—"
                ) : (
                  t("academicGrading.equivalency.sourceValue", {
                    type: t(`academicGrading.equivalency.partType.${part.type}`),
                    value:
                      part.source_max === null
                        ? format(part.source_value)
                        : `${format(part.source_value)} / ${format(part.source_max)}`,
                  })
                )}
              </Table.Cell>
              <Table.Cell>{percent(part.percentage)}</Table.Cell>
              <Table.Cell>{percent(part.share)}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {estimate.issues.length > 0 ? (
        <ul className="ag-issues" aria-label={t("academicGrading.equivalency.issuesLabel")}>
          {estimate.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="ag-issues__item">
              <Badge tone={issue.kind === "note" ? "neutral" : "warning"}>
                {t(`academicGrading.equivalency.issueKind.${issue.kind}`)}
              </Badge>{" "}
              {equivalencyIssueText(issue, estimate.parts, t, format)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
