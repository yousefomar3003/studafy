import { PERMISSIONS } from "@studafy/constants";
import { validateExternalExamScore } from "@studafy/grading-engine";
import { Button, Card, Input, Modal, Select, Table, useToast } from "@studafy/ui";
import { useMemo, useState } from "react";

import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { ConfirmModal, Num, TextArea } from "../academic-setup/components";
import { problemMessage } from "../academic-setup/errors";
import { useStudentExamEntries } from "../academic-setup/exam-entries";
import {
  useDeleteExternalExamResult,
  useExternalExams,
  useSaveExternalExamResult,
  useStudentExternalExamResults,
} from "../academic-setup/external-exams";
import { useSubjects } from "../school/queries";

import type { ExternalExam, ExternalExamResult } from "../academic-setup/external-exams";
import type { ExternalExamComponentDefinition } from "@studafy/grading-engine";
import type { FormEvent } from "react";

import "../academic-setup/academic-setup.css";

/** "720" or "A*" for one score. */
function scoreText(
  score: ExternalExamResult["scores"][number],
  format: (value: number) => string,
): string {
  return score.numeric_score !== null ? format(score.numeric_score) : (score.label_score ?? "—");
}

/**
 * A student's external exams and test scores (SAT, IELTS, IGCSE finals...) on the principal's
 * student page. Leadership (academicConfig:manage) records, edits and deletes them; totals are
 * worked out by the API from the scores. The exams themselves are set up in Academic setup.
 */
export function TestScoresPanel({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const { show } = useToast();
  const permissions = usePermissions();
  const canManage = permissions.has(PERMISSIONS.ACADEMIC_CONFIG_MANAGE);
  const results = useStudentExternalExamResults(studentId);
  const remove = useDeleteExternalExamResult();
  const [editing, setEditing] = useState<{ result: ExternalExamResult | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ExternalExamResult | null>(null);

  const format = (value: number) => formatNumber(value, { maximumFractionDigits: 2 });
  const day = (date: string) => formatDate(new Date(`${date}T00:00:00`), { dateStyle: "medium" });

  return (
    <Card as="section" aria-labelledby="student-test-scores-heading">
      <Card.Header>
        <h2 id="student-test-scores-heading">{t("academicGrading.testScores.heading")}</h2>
        {canManage ? (
          <Button type="button" variant="secondary" onClick={() => setEditing({ result: null })}>
            {t("academicGrading.testScores.add")}
          </Button>
        ) : null}
      </Card.Header>
      <Card.Body>
        <Table caption={t("academicGrading.testScores.caption")} hideCaption>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("academicGrading.testScores.columns.date")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.testScores.columns.exam")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.testScores.columns.scores")}</Table.HeaderCell>
              <Table.HeaderCell>{t("academicGrading.testScores.columns.total")}</Table.HeaderCell>
              {canManage ? (
                <Table.HeaderCell>
                  {t("academicGrading.testScores.columns.actions")}
                </Table.HeaderCell>
              ) : null}
            </Table.Row>
          </Table.Header>
          <Table.Body
            columnCount={canManage ? 5 : 4}
            loading={results.isPending}
            empty={
              results.isError
                ? t("academicGrading.testScores.error")
                : t("academicGrading.testScores.empty")
            }
          >
            {(results.data ?? []).map((result) => (
              <Table.Row key={result.id}>
                <Table.Cell>{day(result.sat_on)}</Table.Cell>
                <Table.Cell>
                  {result.subject
                    ? t("academicGrading.testScores.examSubject", {
                        exam: result.exam.name,
                        subject: result.subject.name,
                      })
                    : result.exam.name}
                </Table.Cell>
                <Table.Cell>
                  {result.scores
                    .map((score) =>
                      t("academicGrading.testScores.scoreLine", {
                        component: score.component_name,
                        score: scoreText(score, format),
                      }),
                    )
                    .join(" · ")}
                  {result.note ? <div className="ag-muted">{result.note}</div> : null}
                </Table.Cell>
                <Table.Cell>
                  {result.total_score === null ? (
                    "—"
                  ) : result.exam.total_max !== null ? (
                    t("academicGrading.testScores.outOf", {
                      score: format(result.total_score),
                      max: format(result.exam.total_max),
                    })
                  ) : (
                    <Num value={result.total_score} />
                  )}
                </Table.Cell>
                {canManage ? (
                  <Table.Cell>
                    <div className="sections-page__row-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        aria-label={t("academicGrading.testScores.editLabel", {
                          exam: result.exam.name,
                        })}
                        onClick={() => setEditing({ result })}
                      >
                        {t("academicGrading.common.edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-label={t("academicGrading.testScores.deleteLabel", {
                          exam: result.exam.name,
                        })}
                        onClick={() => setPendingDelete(result)}
                      >
                        {t("academicGrading.common.remove")}
                      </Button>
                    </div>
                  </Table.Cell>
                ) : null}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </Card.Body>
      {editing ? (
        <ResultForm
          key={editing.result?.id ?? "new"}
          studentId={studentId}
          result={editing.result}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmModal
        open={pendingDelete !== null}
        title={t("academicGrading.testScores.deleteTitle", {
          exam: pendingDelete?.exam.name ?? "",
        })}
        description={t("academicGrading.testScores.deleteDescription")}
        confirmLabel={t("academicGrading.common.remove")}
        submitting={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, {
            onSuccess: () => {
              show({ variant: "success", title: t("academicGrading.testScores.deleted") });
              setPendingDelete(null);
            },
            onError: (error) => {
              show({
                variant: "error",
                title: t("academicGrading.testScores.deleteFailed"),
                description: problemMessage(error, t),
              });
              setPendingDelete(null);
            },
          })
        }
      />
    </Card>
  );
}

function asDefinition(
  component: ExternalExam["components"][number],
): ExternalExamComponentDefinition {
  return {
    name: component.name,
    scoreType: component.score_type,
    minScore: component.min_score,
    maxScore: component.max_score,
    step: component.step,
    allowedLabels: component.allowed_labels ? [...component.allowed_labels] : null,
  };
}

/** Record a new result (any active exam) or edit one (its exam stays). */
function ResultForm({
  studentId,
  result,
  onClose,
}: {
  studentId: string;
  result: ExternalExamResult | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  // Editing a result of an archived exam still needs that exam's components.
  const exams = useExternalExams(result !== null);
  const subjects = useSubjects();
  const save = useSaveExternalExamResult(studentId);
  const examEntries = useStudentExamEntries(studentId);
  const [examId, setExamId] = useState<string | undefined>(result?.exam.id);
  const [entryId, setEntryId] = useState(result?.entry_id ?? "");
  const [subjectId, setSubjectId] = useState<string | undefined>(result?.subject?.id);
  const [satOn, setSatOn] = useState(result?.sat_on ?? "");
  const [note, setNote] = useState(result?.note ?? "");
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (result?.scores ?? []).map((score) => [
        score.component_id,
        score.numeric_score !== null ? String(score.numeric_score) : (score.label_score ?? ""),
      ]),
    ),
  );
  const exam = exams.data?.find((candidate) => candidate.id === examId);
  // The student's entries for this exam (and subject) a result can be recorded from.
  const linkable = (examEntries.data ?? []).filter(
    (entry) =>
      entry.exam.id === examId &&
      (!subjectId ||
        entry.subjects.length === 0 ||
        entry.subjects.some((subject) => subject.subject?.id === subjectId)),
  );

  const problems = useMemo(() => {
    const found: Record<string, string> = {};
    for (const component of exam?.components ?? []) {
      const raw = (scores[component.id] ?? "").trim();
      if (raw === "") continue;
      const value = component.score_type === "numeric" ? Number(raw) : raw;
      const issue = validateExternalExamScore(asDefinition(component), value);
      if (issue) found[component.id] = issue.message;
    }
    return found;
  }, [exam, scores]);
  const entered = (exam?.components ?? []).filter(
    (component) => (scores[component.id] ?? "").trim() !== "",
  );
  const incomplete =
    !exam ||
    satOn === "" ||
    (exam.per_subject && !subjectId) ||
    entered.length === 0 ||
    Object.keys(problems).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!exam || incomplete) return;
    const body = {
      subject_id: exam.per_subject ? (subjectId ?? null) : null,
      entry_id: entryId === "" ? null : entryId,
      sat_on: satOn,
      note: note.trim() === "" ? null : note.trim(),
      scores: entered.map((component) => {
        const raw = scores[component.id]!.trim();
        return component.score_type === "numeric"
          ? { component_id: component.id, numeric_score: Number(raw) }
          : { component_id: component.id, label_score: raw };
      }),
    };
    save.mutate(
      result
        ? { resultId: result.id, body }
        : { resultId: null, body: { exam_id: exam.id, ...body } },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("academicGrading.testScores.saved") });
          onClose();
        },
      },
    );
  }

  const choosable = (exams.data ?? []).filter(
    (candidate) => candidate.archived_at === null || candidate.id === result?.exam.id,
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="wide"
      title={
        result
          ? t("academicGrading.testScores.editTitle", { exam: result.exam.name })
          : t("academicGrading.testScores.add")
      }
    >
      <form onSubmit={submit} noValidate>
        <Modal.Body>
          {exams.isError ? (
            <p className="ag-error" role="alert">
              {problemMessage(exams.error, t)}
            </p>
          ) : null}
          {!result && exams.isSuccess && choosable.length === 0 ? (
            <p className="ag-muted">{t("academicGrading.testScores.noExams")}</p>
          ) : null}
          <div className="ag-grid ag-grid--dense">
            <Select
              label={t("academicGrading.testScores.exam")}
              placeholder={t("academicGrading.testScores.examPlaceholder")}
              options={choosable.map((candidate) => ({
                value: candidate.id,
                label: candidate.name,
              }))}
              value={examId}
              required
              disabled={result !== null || exams.isPending}
              onChange={(id) => {
                setExamId(id);
                setEntryId("");
                setScores({});
              }}
            />
            {exam?.per_subject ? (
              <Select
                label={t("academicGrading.testScores.subject")}
                placeholder={t("academicGrading.testScores.subjectPlaceholder")}
                options={(subjects.data ?? []).map((subject) => ({
                  value: subject.id,
                  label: subject.name,
                }))}
                value={subjectId}
                required
                onChange={setSubjectId}
              />
            ) : null}
            {linkable.length > 0 || entryId !== "" ? (
              <Select
                label={t("academicGrading.testScores.entry")}
                options={[
                  { value: "", label: t("academicGrading.testScores.noEntry") },
                  ...linkable.map((entry) => ({
                    value: entry.id,
                    label: t("academicGrading.testScores.entryOption", {
                      series: entry.session.series,
                      number: entry.candidate_number ?? "—",
                    }),
                  })),
                ]}
                value={entryId}
                onChange={setEntryId}
              />
            ) : null}
            <Input
              label={t("academicGrading.testScores.date")}
              type="date"
              value={satOn}
              required
              onChange={(event) => setSatOn(event.target.value)}
            />
          </div>
          {exam ? (
            <fieldset className="ag-fieldset">
              <legend>{t("academicGrading.testScores.scores")}</legend>
              <p className="ag-muted">{t("academicGrading.testScores.scoresHelp")}</p>
              <div className="ag-grid ag-grid--dense">
                {exam.components.map((component) =>
                  component.score_type === "numeric" ? (
                    <Input
                      key={component.id}
                      label={component.name}
                      type="number"
                      min={component.min_score ?? undefined}
                      max={component.max_score ?? undefined}
                      step={component.step ?? "any"}
                      helperText={t("academicGrading.testScores.range", {
                        min: component.min_score,
                        max: component.max_score,
                      })}
                      value={scores[component.id] ?? ""}
                      error={problems[component.id]}
                      onChange={(event) =>
                        setScores((prev) => ({ ...prev, [component.id]: event.target.value }))
                      }
                    />
                  ) : (
                    <Select
                      key={component.id}
                      label={component.name}
                      placeholder={t("academicGrading.testScores.notScored")}
                      options={[
                        { value: "", label: t("academicGrading.testScores.notScored") },
                        ...(component.allowed_labels ?? []).map((label) => ({
                          value: label,
                          label,
                        })),
                      ]}
                      value={scores[component.id] ?? ""}
                      onChange={(value) =>
                        setScores((prev) => ({ ...prev, [component.id]: value }))
                      }
                    />
                  ),
                )}
              </div>
            </fieldset>
          ) : null}
          <TextArea label={t("academicGrading.testScores.note")} value={note} onChange={setNote} />
          {save.isError ? (
            <p className="ag-error" role="alert">
              {problemMessage(save.error, t)}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("academicGrading.common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={incomplete}>
            {t("academicGrading.testScores.save")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
