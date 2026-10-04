import { ApiError } from "@studafy/api-client";
import { Button, Input, Select, Table, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Trans, useFormatters, useTranslation } from "../../../lib/i18n";
import { DATE_TIME_OPTIONS } from "../format";

import {
  EVALUATION_RATING_LABEL_KEYS,
  EVALUATION_STATUS_LABEL_KEYS,
  EVALUATION_TYPE_LABEL_KEYS,
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

/** Translation key for an autosave indicator; `idle` shows nothing. */
const AUTOSAVE_LABEL_KEYS: Record<Exclude<AutosaveStatus, "idle">, string> = {
  saving: "principal.evaluations.detail.autosave.saving",
  saved: "principal.evaluations.detail.autosave.saved",
  error: "principal.evaluations.detail.autosave.error",
};

/** Locale-aware date helpers shared by the components below. */
function useDateFormatters() {
  const { formatDate: formatLocaleDate } = useFormatters();
  return {
    formatDateTime: (iso: string) => formatLocaleDate(new Date(iso), DATE_TIME_OPTIONS),
    formatDate: (iso: string | null) => (iso ? formatLocaleDate(new Date(iso)) : "—"),
  };
}

function AutosaveIndicator({ status }: { status: AutosaveStatus }) {
  const { t } = useTranslation();
  return (
    <span className="evaluations-autosave" data-status={status}>
      {status === "idle" ? "" : t(AUTOSAVE_LABEL_KEYS[status])}
    </span>
  );
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
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
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
          label={t("principal.evaluations.detail.scoreLabel", {
            max: formatNumber(template.max_score),
          })}
          type="number"
          min={0}
          max={template.max_score}
          value={scoreText}
          disabled={readOnly}
          error={
            scoreText.trim() !== "" && !isValidScore
              ? t("principal.evaluations.detail.outOfRange")
              : undefined
          }
          onChange={(event) => setScoreText(event.target.value)}
        />
      </Table.Cell>
      <Table.Cell>
        <Input
          label={t("principal.evaluations.detail.comment")}
          value={comment}
          disabled={readOnly}
          onChange={(event) => setComment(event.target.value)}
        />
      </Table.Cell>
      <Table.Cell>
        <AutosaveIndicator status={status} />
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

const RATINGS = Object.keys(EVALUATION_RATING_LABEL_KEYS) as EvaluationRating[];

interface EvaluationHistoryProps {
  evaluationId: string;
  teacherId: string;
}

/** Prior evaluation cycles for this teacher, newest first, excluding the one currently open —
 * satisfies the "history" deliverable by reusing the same list endpoint `EvaluationListPage` calls,
 * scoped to one teacher rather than adding a dedicated history endpoint. */
function EvaluationHistory({ evaluationId, teacherId }: EvaluationHistoryProps) {
  const { t } = useTranslation();
  const { formatDate } = useDateFormatters();
  const historyQuery = useQuery({
    queryKey: evaluationListKey({ teacherId }),
    queryFn: () => fetchEvaluations({ teacherId }),
  });

  const history = (historyQuery.data ?? [])
    .filter((evaluation) => evaluation.id !== evaluationId)
    .sort((a, b) => b.evaluated_at.localeCompare(a.evaluated_at));

  return (
    <section
      className="evaluations-detail__section"
      aria-label={t("principal.evaluations.detail.historyTitle")}
    >
      <h2>{t("principal.evaluations.detail.historyTitle")}</h2>
      {historyQuery.isPending ? (
        <p role="status">{t("principal.common.loading")}</p>
      ) : history.length === 0 ? (
        <p className="evaluations-detail__hint">{t("principal.evaluations.detail.historyEmpty")}</p>
      ) : (
        <ul className="evaluations-history">
          {history.map((evaluation) => (
            <li key={evaluation.id} className="evaluations-history__item">
              <Link to={`/portal/principal/evaluations/${evaluation.id}`}>
                {t("principal.evaluations.detail.historyItem", {
                  type: t(EVALUATION_TYPE_LABEL_KEYS[evaluation.evaluation_type]),
                  date: formatDate(evaluation.evaluated_at),
                })}
              </Link>
              <span className="evaluations-history__status">
                {t(EVALUATION_STATUS_LABEL_KEYS[evaluation.status])}
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
  const { t } = useTranslation();
  const { formatDate, formatDateTime } = useDateFormatters();
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

  const ratingOptions: SelectOption<EvaluationRating>[] = RATINGS.map((value) => ({
    value,
    label: t(EVALUATION_RATING_LABEL_KEYS[value]),
  }));

  const scoresByTemplateId = new Map(
    evaluation.scores.map((score) => [score.criteria_template_id, score]),
  );

  function handleSubmit() {
    submit.mutate(undefined, {
      onSuccess: () =>
        show({ variant: "success", title: t("principal.evaluations.detail.submitted") }),
      onError: (error) =>
        show({
          variant: "error",
          title: t("principal.evaluations.detail.submitFailed"),
          description: apiErrorDescription(error),
        }),
    });
  }

  function handleShare() {
    share.mutate(undefined, {
      onSuccess: () =>
        show({ variant: "success", title: t("principal.evaluations.detail.sharedToast") }),
      onError: (error) =>
        show({
          variant: "error",
          title: t("principal.evaluations.detail.shareFailed"),
          description: apiErrorDescription(error),
        }),
    });
  }

  return (
    <>
      <h1>{teacherName}</h1>

      <dl className="evaluations-detail__summary">
        <div>
          <dt>{t("principal.evaluations.detail.type")}</dt>
          <dd>{t(EVALUATION_TYPE_LABEL_KEYS[evaluation.evaluation_type])}</dd>
        </div>
        <div>
          <dt>{t("principal.evaluations.detail.status")}</dt>
          <dd>{t(EVALUATION_STATUS_LABEL_KEYS[evaluation.status])}</dd>
        </div>
        <div>
          <dt>{t("principal.evaluations.detail.rating")}</dt>
          <dd>
            {evaluation.rating ? (
              <span className="evaluations-rating-pill" data-tone={ratingTone(evaluation.rating)}>
                {t(EVALUATION_RATING_LABEL_KEYS[evaluation.rating])}
              </span>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>{t("principal.evaluations.detail.evaluatedAt")}</dt>
          <dd>{formatDateTime(evaluation.evaluated_at)}</dd>
        </div>
        <div>
          <dt>{t("principal.evaluations.detail.sharedWithTeacher")}</dt>
          <dd>
            {evaluation.shared_with_teacher
              ? t("principal.evaluations.detail.sharedOn", {
                  date: formatDate(evaluation.shared_at),
                })
              : t("principal.evaluations.detail.notShared")}
          </dd>
        </div>
      </dl>

      <section
        className="evaluations-detail__section"
        aria-label={t("principal.evaluations.detail.workflow")}
      >
        <h2>{t("principal.evaluations.detail.workflow")}</h2>
        <div className="evaluations-detail__workflow-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={evaluation.status !== "draft"}
            loading={submit.isPending}
            onClick={handleSubmit}
          >
            {t("principal.evaluations.detail.submit")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={evaluation.status === "draft" || evaluation.shared_with_teacher}
            loading={share.isPending}
            onClick={handleShare}
          >
            {t("principal.evaluations.detail.share")}
          </Button>
        </div>
        {evaluation.status === "draft" ? (
          <p className="evaluations-detail__hint">{t("principal.evaluations.detail.submitHint")}</p>
        ) : null}
      </section>

      <section
        className="evaluations-detail__section"
        aria-label={t("principal.evaluations.detail.criteriaScoring")}
      >
        <h2>{t("principal.evaluations.detail.criteriaScoring")}</h2>
        {templates.length === 0 ? (
          <p className="evaluations-detail__hint">
            <Trans
              i18nKey="principal.evaluations.detail.noTemplates"
              components={{ link: <Link to="/portal/principal/evaluations/templates" /> }}
            />
          </p>
        ) : (
          <Table caption={t("principal.evaluations.detail.scoresCaption")}>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>
                  {t("principal.evaluations.detail.scoreColumns.criteria")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.evaluations.detail.scoreColumns.score")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.evaluations.detail.scoreColumns.comment")}
                </Table.HeaderCell>
                <Table.HeaderCell>
                  {t("principal.evaluations.detail.scoreColumns.saved")}
                </Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body
              columnCount={SCORE_COLUMN_COUNT}
              empty={t("principal.evaluations.detail.noTemplatesShort")}
            >
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

      <section
        className="evaluations-detail__section"
        aria-label={t("principal.evaluations.detail.narrative")}
      >
        <div className="evaluations-detail__section-header">
          <h2>{t("principal.evaluations.detail.narrative")}</h2>
          <AutosaveIndicator status={notesStatus} />
        </div>

        {readOnly ? (
          <p className="evaluations-detail__hint">
            {t("principal.evaluations.detail.readOnlyHint")}
          </p>
        ) : null}

        <div className="evaluations-form">
          <Select
            label={t("principal.evaluations.detail.overallRating")}
            options={ratingOptions}
            value={notes.rating || undefined}
            placeholder={t("principal.evaluations.detail.noRating")}
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, rating: value }))}
          />
          <TextField
            label={t("principal.evaluations.detail.strengths")}
            value={notes.strengths}
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, strengths: value }))}
          />
          <TextField
            label={t("principal.evaluations.detail.areasForImprovement")}
            value={notes.areas_for_improvement}
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, areas_for_improvement: value }))}
          />
          <TextField
            label={t("principal.evaluations.detail.comments")}
            value={notes.comments}
            disabled={readOnly}
            onChange={(value) => setNotes((prev) => ({ ...prev, comments: value }))}
          />
          <TextField
            label={t("principal.evaluations.detail.narrative")}
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
  const { t } = useTranslation();
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
      {t("principal.evaluations.backToList")}
    </Link>
  );

  if (evaluationQuery.isPending || templatesQuery.isPending) {
    return (
      <>
        {backLink}
        <p role="status">{t("principal.common.loading")}</p>
      </>
    );
  }

  if (evaluationQuery.isError || !evaluationQuery.data) {
    return (
      <>
        {backLink}
        <p role="alert">{t("principal.evaluations.detail.loadError")}</p>
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
