import { Button, Checkbox, Input, Modal, Select, Table, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../../lib/i18n";
import { useSubjects } from "../school/queries";
import { useGradeLevels } from "../sections/queries";

import {
  useCreateLearningOutcome,
  useDeleteLearningOutcome,
  useImportLearningOutcomes,
  useLearningOutcomes,
  usePlanningSettings,
  useUpdateLearningOutcome,
  useUpdatePlanningSettings,
} from "./academic-planning";
import { Badge, ConfirmModal, QueryState, TextArea } from "./components";
import { problemMessage } from "./errors";

import type {
  LearningOutcome,
  LearningOutcomeImportResult,
  PlanningSettings,
} from "./academic-planning";
import type { SetupContext } from "./context";

const ALL = "__all__";

/**
 * Learning outcomes (000268): the school's achievement scale and whether achievement shows on
 * report cards, when plans are due, and the outcomes catalogue per subject and grade (add, edit,
 * archive, delete an unused one, import from CSV). Leadership with academicConfig:manage edits;
 * teachers record achievement against these outcomes in the mobile app.
 */
export function LearningOutcomesTab({ ctx }: { ctx: SetupContext }) {
  const settings = usePlanningSettings();
  return (
    <>
      <QueryState isPending={settings.isPending} error={settings.error}>
        {settings.data ? <SettingsBlock ctx={ctx} settings={settings.data} /> : null}
      </QueryState>
      <CatalogueBlock ctx={ctx} />
    </>
  );
}

function SettingsBlock({ ctx, settings }: { ctx: SetupContext; settings: PlanningSettings }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const canManage = ctx.can.manage;
  const update = useUpdatePlanningSettings();
  const [showOnReports, setShowOnReports] = useState(settings.show_outcomes_on_report_cards);
  const [leadDays, setLeadDays] = useState(String(settings.lesson_plan_lead_days));
  const [dueDays, setDueDays] = useState(String(settings.term_plan_due_days));
  const [levels, setLevels] = useState(
    settings.achievement_levels.map((level) => ({
      label: level.label,
      label_ar: level.label_ar ?? "",
    })),
  );
  const invalidLevels = levels.some((level) => level.label.trim() === "");

  function setLevel(index: number, patch: Partial<{ label: string; label_ar: string }>) {
    setLevels((prev) => prev.map((level, i) => (i === index ? { ...level, ...patch } : level)));
  }

  function save() {
    update.mutate(
      {
        show_outcomes_on_report_cards: showOnReports,
        lesson_plan_lead_days: Number(leadDays),
        term_plan_due_days: Number(dueDays),
        achievement_levels: levels.map((level) => ({
          label: level.label.trim(),
          label_ar: level.label_ar.trim() || null,
        })),
      },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("academicGrading.outcomes.settingsSaved") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.outcomes.settingsFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <section className="ag-block" aria-labelledby="ag-outcome-settings-heading">
      <h2 id="ag-outcome-settings-heading">{t("academicGrading.outcomes.settingsHeading")}</h2>
      <p className="ag-muted">{t("academicGrading.outcomes.settingsHelp")}</p>
      <Checkbox
        label={t("academicGrading.outcomes.showOnReports")}
        checked={showOnReports}
        disabled={!canManage}
        onChange={(event) => setShowOnReports(event.target.checked)}
      />
      <fieldset className="ag-fieldset">
        <legend>{t("academicGrading.outcomes.scaleLegend")}</legend>
        <p className="ag-muted">{t("academicGrading.outcomes.scaleHelp")}</p>
        <ol className="ag-conduct-list">
          {levels.map((level, index) => (
            <li key={index} className="ag-grid ag-grid--dense">
              <Input
                label={t("academicGrading.outcomes.levelLabel", { n: index + 1 })}
                value={level.label}
                maxLength={60}
                disabled={!canManage}
                onChange={(event) => setLevel(index, { label: event.target.value })}
              />
              <Input
                label={t("academicGrading.outcomes.levelLabelAr", { n: index + 1 })}
                value={level.label_ar}
                maxLength={60}
                dir="rtl"
                lang="ar"
                disabled={!canManage}
                onChange={(event) => setLevel(index, { label_ar: event.target.value })}
              />
              {canManage ? (
                <Button
                  type="button"
                  variant="tertiary"
                  disabled={levels.length <= 2}
                  aria-label={t("academicGrading.outcomes.removeLevel", { n: index + 1 })}
                  onClick={() => setLevels((prev) => prev.filter((_, i) => i !== index))}
                >
                  {t("academicGrading.common.remove")}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
        {canManage && levels.length < 10 ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLevels((prev) => [...prev, { label: "", label_ar: "" }])}
          >
            {t("academicGrading.outcomes.addLevel")}
          </Button>
        ) : null}
      </fieldset>
      <fieldset className="ag-fieldset">
        <legend>{t("academicGrading.outcomes.dueLegend")}</legend>
        <div className="ag-grid ag-grid--dense">
          <Input
            type="number"
            min={0}
            max={30}
            label={t("academicGrading.outcomes.leadDays")}
            helperText={t("academicGrading.outcomes.leadDaysHelp")}
            value={leadDays}
            disabled={!canManage}
            onChange={(event) => setLeadDays(event.target.value)}
          />
          <Input
            type="number"
            min={-90}
            max={90}
            label={t("academicGrading.outcomes.dueDays")}
            helperText={t("academicGrading.outcomes.dueDaysHelp")}
            value={dueDays}
            disabled={!canManage}
            onChange={(event) => setDueDays(event.target.value)}
          />
        </div>
      </fieldset>
      {canManage ? (
        <Button type="button" loading={update.isPending} disabled={invalidLevels} onClick={save}>
          {t("academicGrading.outcomes.saveSettings")}
        </Button>
      ) : null}
    </section>
  );
}

function CatalogueBlock({ ctx }: { ctx: SetupContext }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const canManage = ctx.can.manage;
  const subjects = useSubjects();
  const grades = useGradeLevels();
  const [subjectId, setSubjectId] = useState(ALL);
  const [gradeId, setGradeId] = useState(ALL);
  const outcomes = useLearningOutcomes({
    subjectId: subjectId === ALL ? undefined : subjectId,
    gradeLevelId: gradeId === ALL ? undefined : gradeId,
  });
  const update = useUpdateLearningOutcome();
  const remove = useDeleteLearningOutcome();
  const [editing, setEditing] = useState<{ outcome: LearningOutcome | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<LearningOutcome | null>(null);

  function setArchived(outcome: LearningOutcome, archived: boolean) {
    update.mutate(
      { outcomeId: outcome.id, body: { archived } },
      {
        onError: (error) =>
          show({
            variant: "error",
            title: t("academicGrading.outcomes.saveFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <section className="ag-block" aria-labelledby="ag-outcomes-heading">
      <div className="ag-head">
        <h2 id="ag-outcomes-heading">{t("academicGrading.outcomes.heading")}</h2>
        {canManage ? (
          <div className="sections-page__row-actions">
            <Button type="button" variant="secondary" onClick={() => setImporting(true)}>
              {t("academicGrading.outcomes.import")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing({ outcome: null })}>
              {t("academicGrading.outcomes.add")}
            </Button>
          </div>
        ) : null}
      </div>
      <p className="ag-muted">{t("academicGrading.outcomes.help")}</p>
      <div className="principal-school__filters">
        <Select
          label={t("academicGrading.outcomes.subject")}
          options={[
            { value: ALL, label: t("academicGrading.outcomes.allSubjects") },
            ...(subjects.data ?? []).map((subject) => ({ value: subject.id, label: subject.name })),
          ]}
          value={subjectId}
          onChange={setSubjectId}
        />
        <Select
          label={t("academicGrading.outcomes.grade")}
          options={[
            { value: ALL, label: t("academicGrading.outcomes.allGrades") },
            ...(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name })),
          ]}
          value={gradeId}
          onChange={setGradeId}
        />
      </div>
      <Table caption={t("academicGrading.outcomes.caption")} hideCaption>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>{t("academicGrading.outcomes.columns.code")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.outcomes.columns.text")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.outcomes.columns.subject")}</Table.HeaderCell>
            <Table.HeaderCell>{t("academicGrading.outcomes.columns.strand")}</Table.HeaderCell>
            {canManage ? (
              <Table.HeaderCell>{t("academicGrading.outcomes.columns.actions")}</Table.HeaderCell>
            ) : null}
          </Table.Row>
        </Table.Header>
        <Table.Body
          columnCount={canManage ? 5 : 4}
          loading={outcomes.isPending}
          empty={
            outcomes.isError
              ? problemMessage(outcomes.error, t)
              : t("academicGrading.outcomes.empty")
          }
        >
          {(outcomes.data ?? []).map((outcome) => (
            <Table.Row key={outcome.id}>
              <Table.Cell>
                <strong>{outcome.code}</strong>{" "}
                {outcome.archived ? (
                  <Badge tone="neutral">{t("academicGrading.outcomes.archived")}</Badge>
                ) : null}
              </Table.Cell>
              <Table.Cell>
                {outcome.text}
                {outcome.text_ar ? (
                  <div className="ag-muted" dir="rtl" lang="ar">
                    {outcome.text_ar}
                  </div>
                ) : null}
              </Table.Cell>
              <Table.Cell>
                {outcome.subject_name} · {outcome.grade_level_name}
              </Table.Cell>
              <Table.Cell>{outcome.strand ?? "—"}</Table.Cell>
              {canManage ? (
                <Table.Cell>
                  <div className="sections-page__row-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={t("academicGrading.outcomes.editLabel", { code: outcome.code })}
                      onClick={() => setEditing({ outcome })}
                    >
                      {t("academicGrading.common.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t(
                        outcome.archived
                          ? "academicGrading.outcomes.restoreLabel"
                          : "academicGrading.outcomes.archiveLabel",
                        { code: outcome.code },
                      )}
                      onClick={() => setArchived(outcome, !outcome.archived)}
                    >
                      {t(
                        outcome.archived
                          ? "academicGrading.outcomes.restore"
                          : "academicGrading.outcomes.archive",
                      )}
                    </Button>
                    {outcome.in_use ? null : (
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("academicGrading.outcomes.removeLabel", {
                          code: outcome.code,
                        })}
                        onClick={() => setPendingDelete(outcome)}
                      >
                        {t("academicGrading.common.remove")}
                      </Button>
                    )}
                  </div>
                </Table.Cell>
              ) : null}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {editing ? <OutcomeModal outcome={editing.outcome} onClose={() => setEditing(null)} /> : null}
      {importing ? <ImportModal onClose={() => setImporting(false)} /> : null}
      <ConfirmModal
        open={pendingDelete !== null}
        title={t("academicGrading.outcomes.removeTitle", { code: pendingDelete?.code ?? "" })}
        description={t("academicGrading.outcomes.removeDescription")}
        confirmLabel={t("academicGrading.common.remove")}
        submitting={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSettled: () => setPendingDelete(null),
            onError: (error) =>
              show({
                variant: "error",
                title: t("academicGrading.outcomes.saveFailed"),
                description: problemMessage(error, t),
              }),
          })
        }
      />
    </section>
  );
}

/** Add an outcome (subject, grade, code, text), or edit one's code, text and strand. */
function OutcomeModal({
  outcome,
  onClose,
}: {
  outcome: LearningOutcome | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const subjects = useSubjects(outcome === null);
  const grades = useGradeLevels();
  const create = useCreateLearningOutcome();
  const update = useUpdateLearningOutcome();
  const failure = create.error ?? update.error;
  const [subjectId, setSubjectId] = useState<string | undefined>(outcome?.subject_id);
  const [gradeId, setGradeId] = useState<string | undefined>(outcome?.grade_level_id);
  const [code, setCode] = useState(outcome?.code ?? "");
  const [text, setText] = useState(outcome?.text ?? "");
  const [textAr, setTextAr] = useState(outcome?.text_ar ?? "");
  const [strand, setStrand] = useState(outcome?.strand ?? "");
  const [sortOrder, setSortOrder] = useState(String(outcome?.sort_order ?? 0));
  const ready =
    code.trim() !== "" &&
    text.trim() !== "" &&
    (outcome !== null || (Boolean(subjectId) && Boolean(gradeId)));

  function saved() {
    show({ variant: "success", title: t("academicGrading.outcomes.saved") });
    onClose();
  }

  function submit() {
    const fields = {
      code: code.trim(),
      text: text.trim(),
      text_ar: textAr.trim() || null,
      strand: strand.trim() || null,
      sort_order: Math.max(0, Math.trunc(Number(sortOrder) || 0)),
    };
    if (outcome) {
      update.mutate({ outcomeId: outcome.id, body: fields }, { onSuccess: saved });
    } else if (subjectId && gradeId) {
      create.mutate(
        { subject_id: subjectId, grade_level_id: gradeId, ...fields },
        { onSuccess: saved },
      );
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        outcome
          ? t("academicGrading.outcomes.editTitle", { code: outcome.code })
          : t("academicGrading.outcomes.addTitle")
      }
    >
      <Modal.Body>
        {outcome ? null : (
          <div className="ag-grid ag-grid--dense">
            <Select
              label={t("academicGrading.outcomes.subject")}
              options={(subjects.data ?? []).map((subject) => ({
                value: subject.id,
                label: subject.name,
              }))}
              value={subjectId}
              onChange={setSubjectId}
              placeholder={t("academicGrading.outcomes.pickSubject")}
              required
            />
            <Select
              label={t("academicGrading.outcomes.grade")}
              options={(grades.data ?? []).map((grade) => ({ value: grade.id, label: grade.name }))}
              value={gradeId}
              onChange={setGradeId}
              placeholder={t("academicGrading.outcomes.pickGrade")}
              required
            />
          </div>
        )}
        <div className="ag-grid ag-grid--dense">
          <Input
            label={t("academicGrading.outcomes.code")}
            value={code}
            maxLength={40}
            required
            onChange={(event) => setCode(event.target.value)}
          />
          <Input
            label={t("academicGrading.outcomes.strand")}
            value={strand}
            maxLength={120}
            onChange={(event) => setStrand(event.target.value)}
          />
          <Input
            type="number"
            min={0}
            label={t("academicGrading.outcomes.sortOrder")}
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
          />
        </div>
        <TextArea
          label={t("academicGrading.outcomes.text")}
          value={text}
          onChange={setText}
          required
        />
        <TextArea
          label={t("academicGrading.outcomes.textAr")}
          value={textAr}
          onChange={setTextAr}
        />
        {failure ? (
          <p className="ag-error" role="alert">
            {problemMessage(failure, t)}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.cancel")}
        </Button>
        <Button
          type="button"
          loading={create.isPending || update.isPending}
          disabled={!ready}
          onClick={submit}
        >
          {t("academicGrading.outcomes.save")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Paste or pick a CSV, check it (dry run), then import it. Nothing is written while it has errors. */
function ImportModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const run = useImportLearningOutcomes();
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<LearningOutcomeImportResult | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setCsv(await file.text());
    setReport(null);
  }

  function check() {
    run.mutate({ csv, dry_run: true }, { onSuccess: setReport });
  }

  function apply() {
    run.mutate(
      { csv, dry_run: false },
      {
        onSuccess: (result) => {
          setReport(result);
          if (result.applied) {
            show({
              variant: "success",
              title: t("academicGrading.outcomes.imported", {
                created: result.created,
                updated: result.updated,
              }),
            });
            onClose();
          }
        },
      },
    );
  }

  const checked = report !== null && report.errors.length === 0;

  return (
    <Modal open onClose={onClose} title={t("academicGrading.outcomes.importTitle")}>
      <Modal.Body>
        <p className="ag-muted">{t("academicGrading.outcomes.importHelp")}</p>
        <label className="sf-field__label" htmlFor="ag-outcome-csv-file">
          {t("academicGrading.outcomes.importFile")}
        </label>
        <input
          id="ag-outcome-csv-file"
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(event) => void pick(event.target.files?.[0])}
        />
        <TextArea
          label={t("academicGrading.outcomes.importText")}
          value={csv}
          rows={6}
          onChange={(value) => {
            setCsv(value);
            setReport(null);
          }}
        />
        {report ? (
          <div role="status">
            <p>
              {t("academicGrading.outcomes.importSummary", {
                created: report.created,
                updated: report.updated,
                unchanged: report.unchanged,
              })}
            </p>
            {report.errors.length > 0 ? (
              <ul className="ag-error">
                {report.errors.map((error) => (
                  <li key={error.line}>
                    {t("academicGrading.outcomes.importLine", {
                      line: error.line,
                      message: error.message,
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {run.error ? (
          <p className="ag-error" role="alert">
            {problemMessage(run.error, t)}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("academicGrading.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={run.isPending && !checked}
          disabled={csv.trim() === ""}
          onClick={check}
        >
          {t("academicGrading.outcomes.importCheck")}
        </Button>
        <Button
          type="button"
          loading={run.isPending && checked}
          disabled={!checked}
          onClick={apply}
        >
          {t("academicGrading.outcomes.importApply")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
