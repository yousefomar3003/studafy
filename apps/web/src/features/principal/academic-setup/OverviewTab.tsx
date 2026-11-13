import { Button, Checkbox, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { Badge, ConfirmModal, QueryState, SeverityBadge, YearStatusBadge } from "./components";
import { setupHref } from "./context";
import { problemMessage } from "./errors";
import { useCopyGradingYear, useSetGradingStatus } from "./mutations";
import { useGradeScales, usePublishCheck } from "./queries";

import type { SetupContext } from "./context";
import type { CopyGradingYearSummary, GradingOverview, GradingStatus } from "./queries";

type Counts = GradingOverview["counts"];

interface CountTile {
  key: keyof Counts;
  /** Tab the figure is acted on from. */
  path: string;
  /** A non-zero value needs attention. */
  attention: boolean;
}

const COUNT_TILES: readonly CountTile[] = [
  { key: "subjects_invalid", path: "subjects", attention: true },
  { key: "sections_with_overrides", path: "sections", attention: false },
  { key: "outdated_overrides", path: "sections", attention: true },
  { key: "missing_teacher_assignments", path: "sections", attention: true },
  { key: "students_with_incomplete_marks", path: "results", attention: true },
  { key: "mark_sheets_awaiting_approval", path: "approvals", attention: true },
  { key: "proposed_assessments", path: "approvals", attention: true },
  { key: "certificates_ready", path: "results", attention: false },
  { key: "certificates_blocked", path: "results", attention: true },
  { key: "certificates_needing_reissue", path: "results", attention: true },
];

/** The year's next status after publishing, as the API allows it (draft only goes live). */
function forwardStatus(status: GradingStatus): GradingStatus | undefined {
  if (status === "active") return "finalized";
  if (status === "finalized") return "archived";
  return undefined;
}

/**
 * Readiness dashboard for the selected year: its grading status and the actions that move it,
 * the counts that need attention, the guided set-up checklist, every publish issue, and the
 * "copy from a previous year" shortcut for a fresh draft year.
 */
export function OverviewTab({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { overview, status } = ctx;
  const scales = useGradeScales(ctx.year.id);
  const [dialog, setDialog] = useState<"publish" | "forward" | "unpublish" | "copy" | null>(null);

  if (!overview || !status) {
    return <QueryState isPending error={null} />;
  }

  const counts = overview.counts;
  const subjectCount = overview.grades.reduce((total, grade) => total + grade.subjects.length, 0);
  const isEmpty = counts.grades === 0 && (scales.data?.length ?? 0) === 0;
  const steps = [
    { key: "start", done: !isEmpty, path: "subjects" },
    {
      key: "grades",
      done: counts.grades > 0 && (scales.data?.length ?? 0) > 0,
      path: (scales.data?.length ?? 0) > 0 ? "subjects" : "scales",
    },
    {
      key: "subjects",
      done:
        counts.grades > 0 &&
        overview.grades.every((grade) => grade.subjects.length > 0) &&
        counts.subjects_invalid === 0,
      path: "subjects",
    },
    {
      key: "sections",
      done: counts.sections > 0 && counts.outdated_overrides === 0,
      path: "sections",
    },
    {
      key: "teachers",
      done: counts.sections > 0 && counts.missing_teacher_assignments === 0,
      path: "sections",
    },
    { key: "publish", done: status !== "draft", path: "" },
  ];
  const forward = forwardStatus(status);

  return (
    <>
      <section className="ag-block" aria-labelledby="ag-status-heading">
        <div className="ag-card ag-status">
          <div>
            <h2 id="ag-status-heading" className="ag-status__title">
              {t("academicGrading.overview.statusHeading", { year: overview.year.name })}{" "}
              <YearStatusBadge status={status} />
            </h2>
            <p className="ag-muted">{t(`academicGrading.overview.statusHelp.${status}`)}</p>
          </div>
          {ctx.can.manage ? (
            <div className="ag-actions">
              {status === "draft" ? (
                <>
                  <Button type="button" onClick={() => setDialog("publish")}>
                    {t("academicGrading.overview.publish")}
                  </Button>
                  {isEmpty ? (
                    <Button type="button" variant="secondary" onClick={() => setDialog("copy")}>
                      {t("academicGrading.overview.copy.action")}
                    </Button>
                  ) : null}
                </>
              ) : null}
              {status === "active" ? (
                <Button type="button" variant="secondary" onClick={() => setDialog("unpublish")}>
                  {t("academicGrading.overview.unpublish")}
                </Button>
              ) : null}
              {forward ? (
                <Button type="button" onClick={() => setDialog("forward")}>
                  {t(`academicGrading.overview.moveTo.${forward}`)}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="ag-block" aria-labelledby="ag-counts-heading">
        <h2 id="ag-counts-heading">{t("academicGrading.overview.countsHeading")}</h2>
        <ul className="ag-tiles">
          <li className="ag-tile">
            <span className="ag-tile__value">{formatNumber(counts.grades)}</span>
            <span className="ag-tile__label">{t("academicGrading.overview.counts.grades")}</span>
          </li>
          <li className="ag-tile">
            <span className="ag-tile__value">{formatNumber(subjectCount)}</span>
            <span className="ag-tile__label">{t("academicGrading.overview.counts.subjects")}</span>
          </li>
          <li className="ag-tile">
            <span className="ag-tile__value">{formatNumber(counts.sections)}</span>
            <span className="ag-tile__label">{t("academicGrading.overview.counts.sections")}</span>
          </li>
          {COUNT_TILES.map((tile) => {
            const value = counts[tile.key];
            return (
              <li
                key={tile.key}
                className={`ag-tile${tile.attention && value > 0 ? " ag-tile--attention" : ""}`}
              >
                <Link className="ag-tile__link" to={setupHref(ctx, tile.path)}>
                  <span className="ag-tile__value">{formatNumber(value)}</span>
                  <span className="ag-tile__label">
                    {t(`academicGrading.overview.counts.${tile.key}`)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="ag-block" aria-labelledby="ag-checklist-heading">
        <h2 id="ag-checklist-heading">{t("academicGrading.overview.checklist.heading")}</h2>
        <ol className="ag-checklist">
          {steps.map((step, index) => (
            <li
              key={step.key}
              className={`ag-checklist__step${step.done ? " ag-checklist__step--done" : ""}`}
            >
              <span className="ag-checklist__marker" aria-hidden="true">
                {step.done ? "✓" : formatNumber(index + 1)}
              </span>
              <div className="ag-checklist__body">
                <strong>{t(`academicGrading.overview.checklist.${step.key}.title`)}</strong>{" "}
                <Badge tone={step.done ? "success" : "neutral"}>
                  {step.done
                    ? t("academicGrading.overview.checklist.done")
                    : t("academicGrading.overview.checklist.todo")}
                </Badge>
                <p className="ag-muted">
                  {t(`academicGrading.overview.checklist.${step.key}.help`)}
                </p>
                {step.key === "start" && isEmpty && ctx.can.manage && status === "draft" ? (
                  <Button type="button" variant="secondary" onClick={() => setDialog("copy")}>
                    {t("academicGrading.overview.copy.action")}
                  </Button>
                ) : step.path ? (
                  <Link to={setupHref(ctx, step.path)}>
                    {t(`academicGrading.overview.checklist.${step.key}.link`)}
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="ag-block" aria-labelledby="ag-issues-heading">
        <h2 id="ag-issues-heading">{t("academicGrading.overview.issuesHeading")}</h2>
        {overview.issues.length === 0 ? (
          <p className="ag-muted">{t("academicGrading.overview.noIssues")}</p>
        ) : (
          <ul className="ag-issues">
            {overview.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="ag-issues__item">
                <SeverityBadge severity={issue.severity} /> <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ag-block" aria-labelledby="ag-grades-heading">
        <h2 id="ag-grades-heading">{t("academicGrading.overview.gradesHeading")}</h2>
        <Table caption={t("academicGrading.overview.gradesCaption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>
                {t("academicGrading.overview.gradeColumns.grade")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.overview.gradeColumns.subjects")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.overview.gradeColumns.invalid")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.overview.gradeColumns.sections")}
              </Table.HeaderCell>
              <Table.HeaderCell>
                {t("academicGrading.overview.gradeColumns.overrides")}
              </Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body columnCount={5} empty={t("academicGrading.overview.noGrades")}>
            {overview.grades.map((grade) => (
              <Table.Row key={grade.grade_level_id}>
                <Table.Cell>{grade.grade_level_name}</Table.Cell>
                <Table.Cell>{formatNumber(grade.subjects.length)}</Table.Cell>
                <Table.Cell>
                  {formatNumber(grade.subjects.filter((subject) => !subject.valid).length)}
                </Table.Cell>
                <Table.Cell>{formatNumber(grade.sections.length)}</Table.Cell>
                <Table.Cell>
                  {formatNumber(
                    grade.sections.filter((section) =>
                      section.subjects.some((subject) => subject.source !== "inherited"),
                    ).length,
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </section>

      {dialog === "publish" ? <PublishDialog ctx={ctx} onClose={() => setDialog(null)} /> : null}
      {dialog === "forward" && forward ? (
        <StatusDialog ctx={ctx} target={forward} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "unpublish" ? (
        <StatusDialog ctx={ctx} target="draft" onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "copy" ? <CopyYearDialog ctx={ctx} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

/** Runs the publish check first, lists what blocks publishing, and publishes once nothing does. */
function PublishDialog({ ctx, onClose }: { ctx: SetupContext; onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const check = usePublishCheck(ctx.year.id, true);
  const setStatus = useSetGradingStatus();

  function publish() {
    setStatus.mutate(
      { yearId: ctx.year.id, status: "active" },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.overview.published") });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.overview.statusFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <ConfirmModal
      open
      title={t("academicGrading.overview.publishTitle")}
      description={t("academicGrading.overview.publishDescription")}
      confirmLabel={t("academicGrading.overview.publish")}
      submitting={setStatus.isPending}
      confirmDisabled={!check.data?.ready}
      onCancel={onClose}
      onConfirm={publish}
    >
      <QueryState isPending={check.isPending} error={check.error}>
        {check.data?.ready ? (
          <p>{t("academicGrading.overview.publishReady")}</p>
        ) : (
          <p className="ag-error">{t("academicGrading.overview.publishBlocked")}</p>
        )}
        {check.data && check.data.issues.length > 0 ? (
          <ul className="ag-issues">
            {check.data.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`} className="ag-issues__item">
                <SeverityBadge severity={issue.severity} /> <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </QueryState>
    </ConfirmModal>
  );
}

function StatusDialog({
  ctx,
  target,
  onClose,
}: {
  ctx: SetupContext;
  target: GradingStatus;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const setStatus = useSetGradingStatus();

  function confirm() {
    setStatus.mutate(
      { yearId: ctx.year.id, status: target },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.overview.statusChanged") });
          onClose();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.overview.statusFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <ConfirmModal
      open
      title={t(`academicGrading.overview.confirm.${target}.title`)}
      description={t(`academicGrading.overview.confirm.${target}.description`)}
      confirmLabel={t(`academicGrading.overview.confirm.${target}.action`)}
      submitting={setStatus.isPending}
      onCancel={onClose}
      onConfirm={confirm}
    />
  );
}

/** Starts a draft year from another year's configuration. Marks and results are never copied. */
function CopyYearDialog({ ctx, onClose }: { ctx: SetupContext; onClose: () => void }) {
  const { t } = useTranslation();
  const copy = useCopyGradingYear();
  const sources = ctx.years.filter((candidate) => candidate.id !== ctx.year.id);
  const [sourceId, setSourceId] = useState(sources[0]?.id);
  const [includeTeachers, setIncludeTeachers] = useState(false);
  const [summary, setSummary] = useState<CopyGradingYearSummary | null>(null);

  function submit() {
    if (!sourceId) return;
    copy.mutate(
      {
        yearId: ctx.year.id,
        sourceYearId: sourceId,
        includeTeacherAssignments: includeTeachers,
      },
      { onSuccess: setSummary },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("academicGrading.overview.copy.title", { year: ctx.year.name })}
      description={t("academicGrading.overview.copy.description")}
    >
      <Modal.Body>
        {summary ? (
          <CopySummary summary={summary} />
        ) : (
          <div className="ag-form">
            <Select
              label={t("academicGrading.overview.copy.source")}
              options={sources.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
              value={sourceId}
              onChange={setSourceId}
              placeholder={t("academicGrading.overview.copy.noSource")}
              disabled={sources.length === 0}
              required
            />
            <Checkbox
              label={t("academicGrading.overview.copy.includeTeachers")}
              checked={includeTeachers}
              onChange={(event) => setIncludeTeachers(event.target.checked)}
            />
            <p className="ag-muted">{t("academicGrading.overview.copy.neverCopied")}</p>
            {copy.isError ? (
              <p className="ag-error" role="alert">
                {problemMessage(copy.error, t)}
              </p>
            ) : null}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        {summary ? (
          <Button type="button" onClick={onClose}>
            {t("academicGrading.common.done")}
          </Button>
        ) : (
          <>
            <Button type="button" variant="tertiary" onClick={onClose}>
              {t("academicGrading.common.cancel")}
            </Button>
            <Button type="button" loading={copy.isPending} disabled={!sourceId} onClick={submit}>
              {t("academicGrading.overview.copy.submit")}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  );
}

function CopySummary({ summary }: { summary: CopyGradingYearSummary }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const rows = [
    "scales",
    "grade_programs",
    "sections_created",
    "sections_reused",
    "subject_configs",
    "categories",
    "assessments",
    "teacher_assignments",
  ] as const;
  return (
    <>
      <p role="status">{t("academicGrading.overview.copy.done")}</p>
      <dl className="ag-dl">
        {rows.map((key) => (
          <div key={key}>
            <dt>{t(`academicGrading.overview.copy.counts.${key}`)}</dt>
            {/* eslint-disable-next-line security/detect-object-injection -- `key` comes from the fixed `rows` list */}
            <dd>{formatNumber(summary[key])}</dd>
          </div>
        ))}
      </dl>
      {summary.warnings.length > 0 ? (
        <>
          <h3 className="ag-subheading">{t("academicGrading.overview.copy.warnings")}</h3>
          <ul className="ag-issues">
            {summary.warnings.map((warning) => (
              <li key={warning} className="ag-issues__item">
                <SeverityBadge severity="warning" /> <span>{warning}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
