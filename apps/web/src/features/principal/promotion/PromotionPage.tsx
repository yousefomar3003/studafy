import { Button, Checkbox, Modal, Select, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { LinkButton } from "../../../components/LinkButton";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { pickCurrentYear, useAcademicYears } from "../school/queries";
import { sectionDisplayName } from "../sections/queries";

import { GRADUATE, SKIP, proposedChoice, sectionChoice, summarize, toDecision } from "./choices";
import { useApplyPromotion, usePromotionPreview } from "./queries";

import type { Choice, PromotionSummary } from "./choices";
import type { PromotionPreviewStudent, PromotionTargetSection } from "./queries";
import type { TFunction } from "i18next";

import "../school/principal-school.css";
import "../sections/sections.css";
import "./promotion.css";

const COLUMN_COUNT = 5;

function resultLabel(student: PromotionPreviewStudent, t: TFunction): string {
  switch (student.academic_status) {
    case "promoted":
      return t("principal.promotion.result.promoted");
    case "retained":
      return t("principal.promotion.result.retained");
    case "supplementary":
      return t("principal.promotion.result.supplementary");
    case "incomplete":
      return t("principal.promotion.result.incomplete");
    default:
      return t("principal.promotion.result.none");
  }
}

function targetLabel(section: PromotionTargetSection, t: TFunction): string {
  return sectionDisplayName({ grade_level_name: section.grade_level_name, name: section.name }, t);
}

/**
 * Move students to next year (`/portal/principal/promotion`), gated on `timetable:manage` (the API
 * also needs `academicConfig:manage`). After a year's results are finalized, every student placed in
 * the source year gets a proposed destination in the target year from their annual result; the
 * principal reviews, changes any of them, resolves the students that need a decision, and confirms.
 * Confirming places students (enrolling them into the new section's classes) or marks graduates;
 * the source year is never changed, and running it again is safe.
 */
export default function PromotionPage() {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { show } = useToast();
  const years = useAcademicYears();
  const yearList = useMemo(() => years.data ?? [], [years.data]);

  const [pickedSource, setPickedSource] = useState<string>();
  const [pickedTarget, setPickedTarget] = useState<string>();
  const source = yearList.find((year) => year.id === pickedSource) ?? pickCurrentYear(yearList);
  const targetOptions = yearList.filter(
    (year) => year.id !== source?.id && (year.status === "planned" || year.status === "active"),
  );
  const target =
    targetOptions.find((year) => year.id === pickedTarget) ??
    [...targetOptions]
      .filter((year) => !source || year.starts_on > source.starts_on)
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0] ??
    targetOptions[0];

  const preview = usePromotionPreview(source?.id, target?.id);
  const apply = useApplyPromotion();

  // The principal's changes, keyed by student; everything else follows the preview's proposal.
  const [overrides, setOverrides] = useState<Map<string, Choice>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkChoice, setBulkChoice] = useState<Choice>("");
  const [confirming, setConfirming] = useState(false);
  const [summary, setSummary] = useState<PromotionSummary | null>(null);

  const students = preview.data?.students ?? [];
  const targetSections = preview.data?.target_sections ?? [];
  const sectionsById = new Map(targetSections.map((section) => [section.id, section]));
  const pending = students.filter((student) => student.done === null);

  function choiceOf(student: PromotionPreviewStudent): Choice {
    return overrides.get(student.student_id) ?? proposedChoice(student);
  }

  function resetFor(change: () => void) {
    change();
    setOverrides(new Map());
    setSelected(new Set());
    setSummary(null);
  }

  function setChoice(studentIds: readonly string[], choice: Choice) {
    setOverrides((current) => {
      const next = new Map(current);
      for (const id of studentIds) next.set(id, choice);
      return next;
    });
  }

  const unresolved = pending.filter((student) => choiceOf(student) === "");
  const incoming = new Map<string, number>();
  for (const student of pending) {
    const choice = choiceOf(student);
    if (choice.startsWith("section:")) {
      const id = choice.slice("section:".length);
      incoming.set(id, (incoming.get(id) ?? 0) + 1);
    }
  }
  const counts = {
    place: pending.filter((student) => choiceOf(student).startsWith("section:")).length,
    graduate: pending.filter((student) => choiceOf(student) === GRADUATE).length,
    skip: pending.filter((student) => choiceOf(student) === SKIP).length,
  };

  const destinationOptions = [
    ...targetSections.map((section) => ({
      value: sectionChoice(section.id),
      label: targetLabel(section, t),
    })),
    { value: GRADUATE, label: t("principal.promotion.choice.graduate") },
    { value: SKIP, label: t("principal.promotion.choice.skip") },
  ];

  // Students grouped by their source section, in the preview's order.
  const groups: { key: string; label: string; students: PromotionPreviewStudent[] }[] = [];
  for (const student of students) {
    const last = groups.at(-1);
    if (last?.key === student.source_section_id) {
      last.students.push(student);
    } else {
      groups.push({
        key: student.source_section_id,
        label: sectionDisplayName(
          { grade_level_name: student.source_grade_level_name, name: student.source_section_name },
          t,
        ),
        students: [student],
      });
    }
  }

  function toggle(studentId: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(studentId);
      else next.delete(studentId);
      return next;
    });
  }

  function confirm() {
    if (!source || !target) return;
    const decisions = pending
      .map((student) => toDecision(student.student_id, choiceOf(student)))
      .filter((decision) => decision !== null);
    apply.mutate(
      { sourceYearId: source.id, targetYearId: target.id, decisions },
      {
        onSuccess: (outcomes) => {
          setConfirming(false);
          setOverrides(new Map());
          setSelected(new Set());
          setSummary(summarize(outcomes, students));
          show({ variant: "success", title: t("principal.promotion.done.toast") });
        },
        onError: (error) => {
          setConfirming(false);
          show({
            variant: "error",
            title: t("principal.promotion.done.failed"),
            description: error instanceof Error ? error.message : undefined,
          });
        },
      },
    );
  }

  return (
    <>
      <div className="principal-school__header">
        <h1>{t("principal.promotion.title")}</h1>
        <LinkButton href="/portal/principal/sections" variant="secondary">
          {t("principal.promotion.sectionsLink")}
        </LinkButton>
      </div>
      <p>{t("principal.promotion.description")}</p>

      <div className="principal-school__filters">
        <Select
          label={t("principal.promotion.fromYear")}
          options={yearList.map((year) => ({ value: year.id, label: year.name }))}
          value={source?.id}
          onChange={(value) => resetFor(() => setPickedSource(value))}
          placeholder={t("principal.school.noYears")}
          disabled={yearList.length === 0}
        />
        <Select
          label={t("principal.promotion.toYear")}
          options={targetOptions.map((year) => ({ value: year.id, label: year.name }))}
          value={target?.id}
          onChange={(value) => resetFor(() => setPickedTarget(value))}
          placeholder={t("principal.promotion.noTargetYear")}
          disabled={targetOptions.length === 0}
        />
      </div>

      {years.isSuccess && targetOptions.length === 0 ? (
        <div className="promotion__notice" role="status">
          <p>{t("principal.promotion.createYearFirst")}</p>
          <LinkButton href="/portal/principal/years" variant="secondary">
            {t("principal.promotion.yearsLink")}
          </LinkButton>
        </div>
      ) : null}

      {summary ? (
        <section className="promotion__summary" aria-labelledby="promotion-summary-heading">
          <h2 id="promotion-summary-heading">{t("principal.promotion.done.heading")}</h2>
          <ul>
            <li>{t("principal.promotion.done.movedUp", { count: summary.movedUp })}</li>
            <li>{t("principal.promotion.done.retained", { count: summary.retained })}</li>
            {summary.moved > 0 ? (
              <li>{t("principal.promotion.done.moved", { count: summary.moved })}</li>
            ) : null}
            <li>{t("principal.promotion.done.graduated", { count: summary.graduated })}</li>
            <li>{t("principal.promotion.done.awaitingResit", { count: summary.awaitingResit })}</li>
            <li>{t("principal.promotion.done.skipped", { count: summary.skipped })}</li>
            {summary.alreadyDone > 0 ? (
              <li>{t("principal.promotion.done.alreadyDone", { count: summary.alreadyDone })}</li>
            ) : null}
            {summary.failed.length > 0 ? (
              <li>{t("principal.promotion.done.failedCount", { count: summary.failed.length })}</li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {preview.isError ? <p role="alert">{t("principal.promotion.loadError")}</p> : null}

      {preview.isSuccess ? (
        <>
          <p className="promotion__counts" aria-live="polite">
            {t("principal.promotion.counts", {
              place: formatNumber(counts.place),
              graduate: formatNumber(counts.graduate),
              skip: formatNumber(counts.skip),
              done: formatNumber(students.length - pending.length),
            })}
          </p>

          <section className="sections-page__block" aria-labelledby="promotion-targets-heading">
            <h2 id="promotion-targets-heading">{t("principal.promotion.targets.heading")}</h2>
            {targetSections.length === 0 ? (
              <p>{t("principal.promotion.targets.empty")}</p>
            ) : (
              <Table caption={t("principal.promotion.targets.caption")} hideCaption>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>{t("principal.promotion.targets.section")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("principal.promotion.targets.placed")}</Table.HeaderCell>
                    <Table.HeaderCell>{t("principal.promotion.targets.incoming")}</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body columnCount={3}>
                  {targetSections.map((section) => (
                    <Table.Row key={section.id}>
                      <Table.Cell>{targetLabel(section, t)}</Table.Cell>
                      <Table.Cell>{formatNumber(section.student_count)}</Table.Cell>
                      <Table.Cell>{formatNumber(incoming.get(section.id) ?? 0)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
          </section>

          <div className="promotion__bulk">
            <span>{t("principal.promotion.bulk.selected", { count: selected.size })}</span>
            <Select
              label={t("principal.promotion.bulk.label")}
              options={destinationOptions}
              value={bulkChoice || undefined}
              onChange={setBulkChoice}
              placeholder={t("principal.promotion.choice.placeholder")}
              disabled={selected.size === 0}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={selected.size === 0 || bulkChoice === ""}
              onClick={() => {
                setChoice([...selected], bulkChoice);
                setSelected(new Set());
              }}
            >
              {t("principal.promotion.bulk.apply")}
            </Button>
          </div>

          {students.length === 0 ? <p>{t("principal.promotion.empty")}</p> : null}

          {groups.map((group) => {
            const selectable = group.students.filter((student) => student.done === null);
            const allSelected =
              selectable.length > 0 &&
              selectable.every((student) => selected.has(student.student_id));
            const someSelected = selectable.some((student) => selected.has(student.student_id));
            return (
              <section
                key={group.key}
                className="sections-page__block"
                aria-label={t("principal.promotion.groupLabel", { section: group.label })}
              >
                <div className="sections-page__head">
                  <h2>{group.label}</h2>
                  {selectable.length > 0 ? (
                    <Checkbox
                      label={t("principal.promotion.selectAll", { section: group.label })}
                      checked={allSelected}
                      indeterminate={someSelected && !allSelected}
                      onChange={(event) => {
                        for (const student of selectable) {
                          toggle(student.student_id, event.target.checked);
                        }
                      }}
                    />
                  ) : null}
                </div>
                <Table caption={group.label} hideCaption>
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>{t("principal.promotion.columns.select")}</Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("principal.promotion.columns.student")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>{t("principal.promotion.columns.result")}</Table.HeaderCell>
                      <Table.HeaderCell>
                        {t("principal.promotion.columns.destination")}
                      </Table.HeaderCell>
                      <Table.HeaderCell>{t("principal.promotion.columns.note")}</Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body columnCount={COLUMN_COUNT}>
                    {group.students.map((student) => {
                      const name = `${student.first_name} ${student.last_name}`;
                      const choice = choiceOf(student);
                      const placedIn = student.placed_section_id
                        ? sectionsById.get(student.placed_section_id)
                        : undefined;
                      return (
                        <Table.Row key={student.student_id}>
                          <Table.Cell>
                            {student.done === null ? (
                              <Checkbox
                                label={t("principal.promotion.selectStudent", { name })}
                                checked={selected.has(student.student_id)}
                                onChange={(event) =>
                                  toggle(student.student_id, event.target.checked)
                                }
                              />
                            ) : null}
                          </Table.Cell>
                          <Table.Cell>
                            {name}
                            {student.admission_number ? (
                              <span className="promotion__muted">
                                {" "}
                                · {student.admission_number}
                              </span>
                            ) : null}
                          </Table.Cell>
                          <Table.Cell>{resultLabel(student, t)}</Table.Cell>
                          <Table.Cell>
                            {student.done === "graduated" ? (
                              t("principal.promotion.doneGraduated")
                            ) : student.done === "placed" ? (
                              t("principal.promotion.donePlaced", {
                                section: placedIn ? targetLabel(placedIn, t) : "",
                              })
                            ) : (
                              <Select
                                label={t("principal.promotion.destinationFor", { name })}
                                options={destinationOptions}
                                value={choice || undefined}
                                onChange={(value) => setChoice([student.student_id], value)}
                                placeholder={t("principal.promotion.choice.placeholder")}
                                error={
                                  choice === "" ? t("principal.promotion.needsDecision") : undefined
                                }
                              />
                            )}
                          </Table.Cell>
                          <Table.Cell>
                            {t(`principal.promotion.reason.${student.reason}`)}
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table>
              </section>
            );
          })}

          <div className="promotion__footer">
            {unresolved.length > 0 ? (
              <p role="status">
                {t("principal.promotion.unresolved", { count: unresolved.length })}
              </p>
            ) : null}
            <Button
              type="button"
              disabled={pending.length === 0 || unresolved.length > 0}
              onClick={() => setConfirming(true)}
            >
              {t("principal.promotion.confirm")}
            </Button>
          </div>
        </>
      ) : null}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("principal.promotion.confirmTitle", { target: target?.name ?? "" })}
        description={t("principal.promotion.confirmDescription", {
          place: counts.place,
          graduate: counts.graduate,
          skip: counts.skip,
          target: target?.name ?? "",
        })}
      >
        <Modal.Footer>
          <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
            {t("principal.common.cancel")}
          </Button>
          <Button type="button" loading={apply.isPending} onClick={confirm}>
            {t("principal.promotion.confirmAction")}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
