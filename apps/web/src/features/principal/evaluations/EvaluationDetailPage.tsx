import { ApiError } from "@studafy/api-client";
import { Button, Input, Select, Table, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  EVALUATION_RATING_LABELS,
  EVALUATION_STATUS_LABELS,
  EVALUATION_TYPE_LABELS,
  ratingTone,
} from "./labels";
import {
  useShareEvaluation,
  useSubmitEvaluation,
  useUpdateEvaluation,
  useUpsertScore,
} from "./mutations";
import {
  evaluationDetailKey,
  evaluationListKey,
  evaluationTemplatesListKey,
  fetchEvaluation,
  fetchEvaluations,
  fetchTemplates,
  fetchTeacherContacts,
  TEACHER_CONTACTS_KEY,
} from "./queries";
import { useAutosave } from "./useAutosave";

import type { EvaluationRating } from "./labels";
import type { EvaluationCriteriaTemplate, EvaluationScore, EvaluationWithScores } from "./queries";
import type { AutosaveStatus } from "./useAutosave";
import type { SelectOption } from "@studafy/ui";

import "./evaluations.css";

const SCORE_COLUMN_COUNT = 4;

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

function autosaveLabel(status: AutosaveStatus): string {
  if (status === "saving") return "Saving…";
  if (status === "saved") return "Saved";
  if (status === "error") return "Couldn't save";
  return "";
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  rows?: number;
}

/** `sf-field`/`sf-input` chrome around a bare `<textarea>` — there is no Textarea primitive in
 * `@studafy/ui`, the same workaround `discipline/ResolveIncidentModal.tsx` uses for its resolution
 * notes field. */
function TextField({ label, value, onChange, disabled = false, rows = 3 }: TextFieldProps) {
  const fieldId = useId();
  return (
    <div className="sf-field">
      <label className="sf-field__label" htmlFor={fieldId}>
        {label}
      </label>
      <div className="sf-input evaluations-textarea">
        <textarea
          id={fieldId}
          className="sf-input__control"
          rows={rows}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

interface ScoreRowProps {
  evaluationId: string;
  template: EvaluationCriteriaTemplate;
  initialScore?: EvaluationScore;
  readOnly: boolean;
}

interface ScoreFieldState {
  scoreText: string;
  comment: string;
}

/** One criteria row in the scoring table. Autosaves both fields together once `scoreText` parses to
 * a number within `[0, template.max_score]` — an in-progress edit (blank, non-numeric, or
 * out-of-range) is never sent, so a stray keystroke can't upsert an invalid score. */
function ScoreRow({ evaluationId, template, initialScore, readOnly }: ScoreRowProps) {
  const [scoreText, setScoreText] = useState(initialScore ? String(initialScore.score) : "");
  const [comment, setComment] = useState(initialScore?.comment ?? "");
  const upsertScore = useUpsertScore(evaluationId);

  const numericScore = Number(scoreText);
  const isValidScore =
    scoreText.trim() !== "" &&
    Number.isFinite(numericScore) &&
    numericScore >= 0 &&
    numericScore <= template.max_score;

  const status = useAutosave<ScoreFieldState>({
    value: { scoreText, comment },
    enabled: !readOnly && isValidScore,
    isEqual: (a, b) => a.scoreText === b.scoreText && a.comment === b.comment,
    onSave: (value) =>
      upsertScore.mutateAsync({
        criteriaTemplateId: template.id,
        input: { score: Number(value.scoreText), comment: value.comment.trim() || undefined },
      }),
  });

  return (
    <Table.Row>
      <Table.Cell>
        <div className="evaluations-score__title">{template.title}</div>
        {template.description ? (
          <div className="evaluations-score__description">{template.description}</div>
        ) : null}
      </Table.Cell>
      <Table.Cell>
        <Input
          label={`Score (0–${template.max_score})`}
          type="number"
          min={0}
          max={template.max_score}
          value={scoreText}
          disabled={readOnly}
          error={scoreText.trim() !== "" && !isValidScore ? "Out of range" : undefined}
          onChange={(event) => setScoreText(event.target.value)}
        />
      </Table.Cell>
      <Table.Cell>
        <Input
          label="Comment"
          value={comment}
          disabled={readOnly}
          onChange={(event) => setComment(event.target.value)}
        />
      </Table.Cell>
      <Table.Cell>
        <span className="evaluations-autosave" data-status={status}>
          {autosaveLabel(status)}
        </span>
      </Table.Cell>
    </Table.Row>
  );
}

interface NotesFormState {
  rating: EvaluationRating | "";
  strengths: string;
  areas_for_improvement: string;
  comments: string;
  narrative: string;
}

function toNotesForm(evaluation: EvaluationWithScores): NotesFormState {
  return {
    rating: evaluation.rating ?? "",
    strengths: evaluation.strengths ?? "",
    areas_for_improvement: evaluation.areas_for_improvement ?? "",
    comments: evaluation.comments ?? "",
    narrative: evaluation.narrative ?? "",
  };
}

const RATING_OPTIONS: SelectOption<EvaluationRating>[] = Object.entries(
  EVALUATION_RATING_LABELS,
).map(([value, label]) => ({ value: value as EvaluationRating, label }));

interface EvaluationHistoryProps {
  evaluationId: string;
  teacherId: string;
}

/** Prior evaluation cycles for this teacher, newest first, excluding the one currently open —
 * satisfies the "history" deliverable by reusing the same list endpoint `EvaluationListPage` calls,
 * scoped to one teacher rather than adding a dedicated history endpoint. */
function EvaluationHistory({ evaluationId, teacherId }: EvaluationHistoryProps) {
  const historyQuery = useQuery({
    queryKey: evaluationListKey({ teacherId }),
    queryFn: () => fetchEvaluations({ teacherId }),
  });

  const history = (historyQuery.data ?? [])
    .filter((evaluation) => evaluation.id !== evaluationId)
    .sort((a, b) => b.evaluated_at.localeCompare(a.evaluated_at));

  return (
    <section className="evaluations-detail__section" aria-label="Evaluation history">
      <h2>Evaluation history</h2>
      {historyQuery.isPending ? (
        <p role="status">Loading…</p>
      ) : history.length === 0 ? (
        <p className="evaluations-detail__hint">No earlier evaluations for this teacher.</p>
      ) : (
        <ul className="evaluations-history">
          {history.map((evaluation) => (
            <li key={evaluation.id} className="evaluations-history__item">
              <Link to={`/portal/principal/evaluations/${evaluation.id}`}>
                {EVALUATION_TYPE_LABELS[evaluation.evaluation_type]} —{" "}
                {formatDate(evaluation.evaluated_at)}
              </Link>
              <span className="evaluations-history__status">
                {EVALUATION_STATUS_LABELS[evaluation.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface EvaluationWorkspaceProps {
  evaluation: EvaluationWithScores;
  templates: EvaluationCriteriaTemplate[];
  teacherName: string;
}

/** Scoring form, narrative editor, and workflow buttons for one evaluation. Keyed by
 * `evaluation.id` on the parent (`EvaluationDetailPage`) so navigating between evaluations remounts
 * this component instead of carrying stale local form state across records. */
function EvaluationWorkspace({ evaluation, templates, teacherName }: EvaluationWorkspaceProps) {
  const { show } = useToast();
  const [notes, setNotes] = useState<NotesFormState>(() => toNotesForm(evaluation));
  const update = useUpdateEvaluation(evaluation.id);
  const submit = useSubmitEvaluation(evaluation.id);
  const share = useShareEvaluation(evaluation.id);

  // Once shared, the teacher can already see this record — further edits would silently go stale
  // for them, so the form locks rather than letting the principal keep changing a record they've
  // already been shown.
  const readOnly = evaluation.shared_with_teacher;

  const notesStatus = useAutosave<NotesFormState>({
    value: notes,
    enabled: !readOnly,
    isEqual: (a, b) =>
      a.rating === b.rating &&
      a.strengths === b.strengths &&
      a.areas_for_improvement === b.areas_for_improvement &&
      a.comments === b.comments &&
      a.narrative === b.narrative,
    onSave: (value) =>
      update.mutateAsync({
        rating: value.rating || undefined,
        strengths: value.strengths.trim(),
        areas_for_improvement: value.areas_for_improvement.trim(),
        comments: value.comments.trim(),
        narrative: value.narrative.trim(),
      }),
  });

  const scoresByTemplateId = new Map(
    evaluation.scores.map((score) => [score.criteria_template_id, score]),
  );

  function handleSubmit() {
    submit.mutate(undefined, {
      onSuccess: () => show({ variant: "success", title: "Evaluation submitted" }),
      onError: (error) =>
        show({
          variant: "error",
          title: "Couldn't submit evaluation",
          description: apiErrorDescription(error),
        }),
    });
  }

  function handleShare() {
    share.mutate(undefined, {
      onSuccess: () => show({ variant: "success", title: "Shared with teacher" }),
      onError: (error) =>
        show({
          variant: "error",
          title: "Couldn't share evaluation",
          description: apiErrorDescription(error),
        }),
    });
  }

  return (
    <>
      <h1>{teacherName}</h1>

      <dl className="evaluations-detail__summary">
        <div>
          <dt>Type</dt>
          <dd>{EVALUATION_TYPE_LABELS[evaluation.evaluation_type]}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{EVALUATION_STATUS_LABELS[evaluation.status]}</dd>
        </div>
        <div>
          <dt>Rating</dt>
          <dd>
            {evaluation.rating ? (
              <span className="evaluations-rating-pill" data-tone={ratingTone(evaluation.rating)}>
                {EVALUATION_RATING_LABELS[evaluation.rating]}
              </span>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>Evaluated at</dt>
          <dd>{formatDateTime(evaluation.evaluated_at)}</dd>
        </div>
        <div>
          <dt>Shared with teacher</dt>
          <dd>
            {evaluation.shared_with_teacher
              ? `Shared on ${formatDate(evaluation.shared_at)}`
              : "Not shared — invisible to the teacher"}
          </dd>
        </div>
      </dl>

      <section className="evaluations-detail__section" aria-label="Workflow">
        <h2>Workflow</h2>
        <div className="evaluations-detail__workflow-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={evaluation.status !== "draft"}
            loading={submit.isPending}
            onClick={handleSubmit}
          >
            Submit
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={evaluation.status === "draft" || evaluation.shared_with_teacher}
            loading={share.isPending}
            onClick={handleShare}
          >
            Share with teacher
          </Button>
        </div>
        {evaluation.status === "draft" ? (
          <p className="evaluations-detail__hint">
            Submit this evaluation before sharing it with the teacher.
          </p>
        ) : null}
      </section>

      <section className="evaluations-detail__section" aria-label="Criteria scoring">
        <h2>Criteria scoring</h2>
        {templates.length === 0 ? (
          <p className="evaluations-detail__hint">
            No active criteria templates.{" "}
            <Link to="/portal/principal/evaluations/templates">Add one</Link> to start scoring.
          </p>
        ) : (
          <Table caption="Criteria scores">
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Criteria</Table.HeaderCell>
                <Table.HeaderCell>Score</Table.HeaderCell>
                <Table.HeaderCell>Comment</Table.HeaderCell>
                <Table.HeaderCell>Saved</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body columnCount={SCORE_COLUMN_COUNT} empty="No active criteria templates.">
              {templates.map((template) => (
                <ScoreRow
                  key={template.id}
                  evaluationId={evaluation.id}
                  template={template}
                  initialScore={scoresByTemplateId.get(template.id)}
                  readOnly={readOnly}
                />
              ))}
            </Table.Body>
          </Table>
        )}
      </section>

      <section className="evaluations-detail__section" aria-label="Narrative">
        <div className="evaluations-detail__section-header">
          <h2>Narrative</h2>
          <span className="evaluations-autosave" data-status={notesStatus}>
            {autosaveLabel(notesStatus)}
          </span>
        </div>

        {readOnly ? (
          <p className="evaluations-detail__hint">
            This evaluation has been shared with the teacher and can no longer be edited.
          </p>
        ) : null}

        <div className="evaluations-form">
          <Select
            label="Overall rating"
            options={RATING_OPTIONS}
            value={notes.rating || undefined}
            placeholder="No rating yet"
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, rating: value }))}
          />
          <TextField
            label="Strengths"
            value={notes.strengths}
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, strengths: value }))}
          />
          <TextField
            label="Areas for improvement"
            value={notes.areas_for_improvement}
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, areas_for_improvement: value }))}
          />
          <TextField
            label="Comments"
            value={notes.comments}
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, comments: value }))}
          />
          <TextField
            label="Narrative"
            rows={6}
            value={notes.narrative}
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, narrative: value }))}
          />
        </div>
      </section>

      <EvaluationHistory evaluationId={evaluation.id} teacherId={evaluation.teacher_id} />
    </>
  );
}

/**
 * Teacher evaluation detail (`/portal/principal/evaluations/:evaluationId`): summary, the
 * criteria-scoring form, the narrative editor (autosaved — see `useAutosave`), the submit/share
 * workflow, and this teacher's evaluation history. Reachable from `EvaluationListPage` and
 * `CreateEvaluationModal`.
 */
export default function EvaluationDetailPage() {
  const { evaluationId = "" } = useParams<{ evaluationId: string }>();

  const evaluationQuery = useQuery({
    queryKey: evaluationDetailKey(evaluationId),
    queryFn: () => fetchEvaluation(evaluationId),
  });
  const templatesQuery = useQuery({
    queryKey: evaluationTemplatesListKey(true),
    queryFn: () => fetchTemplates(true),
  });
  const teachersQuery = useQuery({
    queryKey: TEACHER_CONTACTS_KEY,
    queryFn: fetchTeacherContacts,
  });

  const backLink = (
    <Link className="evaluations-detail__back" to="/portal/principal/evaluations">
      ← Back to evaluations
    </Link>
  );

  if (evaluationQuery.isPending || templatesQuery.isPending) {
    return (
      <>
        {backLink}
        <p role="status">Loading…</p>
      </>
    );
  }

  if (evaluationQuery.isError || !evaluationQuery.data) {
    return (
      <>
        {backLink}
        <p role="alert">Unable to load this evaluation.</p>
      </>
    );
  }

  const teacherName =
    teachersQuery.data?.find((teacher) => teacher.id === evaluationQuery.data.teacher_id)
      ?.display_name ?? evaluationQuery.data.teacher_id;

  return (
    <>
      {backLink}
      <EvaluationWorkspace
        key={evaluationQuery.data.id}
        evaluation={evaluationQuery.data}
        templates={templatesQuery.data ?? []}
        teacherName={teacherName}
      />
    </>
  );
}
