import { Table } from "@studafy/ui";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { Badge } from "./components";

import type { BadgeTone } from "./components";
import type {
  GraduationRuleEvaluation,
  GraduationSet,
  GraduationSetEvaluation,
  GraduationStatus,
} from "./graduation-requirements";
import type { TFunction } from "i18next";

const STATUS_TONE: Record<GraduationStatus, BadgeTone> = {
  met: "success",
  not_met: "danger",
  pending: "warning",
};

/** Met, Not met or In progress. */
export function GraduationStatusBadge({ status }: { status: GraduationStatus }) {
  const { t } = useTranslation();
  // eslint-disable-next-line security/detect-object-injection -- `status` is the closed GraduationStatus union
  const tone = STATUS_TONE[status];
  return <Badge tone={tone}>{t(`academicGrading.graduation.status.${status}`)}</Badge>;
}

type Rule = GraduationSet["rules"][number];

/** "Total credits", "Credits in English", "Pass Core subjects", "SAT"... */
export function graduationRuleLabel(rule: Rule, t: TFunction): string {
  switch (rule.type) {
    case "group_credits":
      return t("academicGrading.graduation.rule.groupCredits", { group: rule.group_name ?? "" });
    case "subjects_passed":
      return t("academicGrading.graduation.rule.subjectsPassed", { group: rule.group_name ?? "" });
    case "external_exam":
      return rule.external_exam?.name ?? t("academicGrading.graduation.ruleType.external_exam");
    default:
      return t(`academicGrading.graduation.ruleType.${rule.type}`);
  }
}

/** What the rule asks for: "At least 24", "English 11, English 12", "Recorded". */
export function graduationRuleRequirement(
  rule: Rule,
  t: TFunction,
  format: (value: number) => string,
): string {
  if (rule.type === "subjects_passed") return rule.subjects.map((s) => s.name).join(", ");
  if (rule.type === "external_exam" && rule.min_value === null) {
    return t("academicGrading.graduation.recorded");
  }
  const atLeast = t("academicGrading.graduation.atLeast", { value: format(rule.min_value ?? 0) });
  return rule.type === "group_credits"
    ? `${atLeast} · ${rule.subjects.map((s) => s.name).join(", ")}`
    : atLeast;
}

/** Where the student stands: "2 of 4", "3.1", "1350" or "—". */
function progress(rule: GraduationRuleEvaluation, t: TFunction, format: (v: number) => string) {
  const counted =
    rule.type === "total_credits" ||
    rule.type === "group_credits" ||
    rule.type === "subjects_passed";
  if (counted && rule.required !== null) {
    return t("academicGrading.graduation.progressOf", {
      current: format(rule.current ?? 0),
      required: format(rule.required),
    });
  }
  return rule.current === null ? "—" : format(rule.current);
}

/**
 * One set's checklist for one student: each rule, what it asks for, where the student stands and
 * whether it is met, not met or still in progress (the current year is not finalized yet).
 */
export function GraduationSetChecklist({
  evaluation,
  headingLevel = 3,
}: {
  evaluation: GraduationSetEvaluation;
  headingLevel?: 3 | 4;
}) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const format = (value: number) => formatNumber(value, { maximumFractionDigits: 2 });
  const Heading = headingLevel === 3 ? "h3" : "h4";

  return (
    <div className="ag-graduation">
      <div className="ag-head">
        <Heading>{evaluation.set.name}</Heading>
        <span>
          <GraduationStatusBadge status={evaluation.status} />{" "}
          <span className="ag-muted">
            {t("academicGrading.graduation.rulesMet", {
              met: formatNumber(evaluation.rules_met),
              total: formatNumber(evaluation.rules_total),
            })}
          </span>
        </span>
      </div>
      <Table
        caption={t("academicGrading.graduation.checklistCaption", { name: evaluation.set.name })}
        hideCaption
      >
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>
              {t("academicGrading.graduation.columns.requirement")}
            </Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.graduation.columns.needs")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.graduation.columns.progress")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.graduation.columns.status")}</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body columnCount={4} empty={t("academicGrading.graduation.noRules")}>
          {evaluation.rules.map((rule) => (
            <Table.Row key={rule.id}>
              <Table.Cell>
                <strong>{graduationRuleLabel(rule, t)}</strong>
                {rule.missing_subjects.length > 0 ? (
                  <div className="ag-muted">
                    {t("academicGrading.graduation.missing", {
                      subjects: rule.missing_subjects.map((subject) => subject.name).join(", "),
                    })}
                  </div>
                ) : null}
              </Table.Cell>
              <Table.Cell>{graduationRuleRequirement(rule, t, format)}</Table.Cell>
              <Table.Cell>{progress(rule, t, format)}</Table.Cell>
              <Table.Cell>
                <GraduationStatusBadge status={rule.status} />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
