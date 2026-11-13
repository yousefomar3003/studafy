import { ApiError } from "@studafy/api-client";
import { Button, Modal, useToast } from "@studafy/ui";
import { useEffect, useId, useState } from "react";
import { useParams } from "react-router-dom";

import { usePortalBack } from "../../../layouts/portal/PortalBackLink";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import {
  AI_REPORT_TRANSITIONS,
  AI_RESOLUTION_NOTE_MAX_LENGTH,
  aiPriorityTone,
  aiStatusTone,
} from "./labels";
import { useAiReport, useReviewAiReport, useStudentNames } from "./queries";

import type { ReviewAiReportInput } from "./queries";

import "../../principal/message-reports/message-reports.css";
import "./ai-reports.css";

type CloseTarget = Exclude<ReviewAiReportInput["status"], "in_review">;

const CLOSE_TARGETS: readonly CloseTarget[] = ["escalated", "actioned", "dismissed"];

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

interface NoteModalProps {
  target: CloseTarget | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (target: CloseTarget, note: string) => void;
}

/** Every move except "start review" needs a note: what was done, or where it was escalated and
 * the external reference. */
function NoteModal({ target, submitting, onClose, onSubmit }: NoteModalProps) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const [showError, setShowError] = useState(false);
  const noteId = useId();
  const errorId = useId();

  useEffect(() => {
    if (target === null) return;
    setNote("");
    setShowError(false);
  }, [target]);

  const trimmed = note.trim();
  const invalid = trimmed.length === 0;

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={target ? t(`adminSchool.aiReports.note.title.${target}`) : ""}
      description={target ? t(`adminSchool.aiReports.note.description.${target}`) : undefined}
    >
      <Modal.Body>
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={noteId}>
            {t("adminSchool.aiReports.note.label")}
          </label>
          <div className="sf-input message-reports__note-input">
            <textarea
              id={noteId}
              className="sf-input__control"
              rows={4}
              required
              maxLength={AI_RESOLUTION_NOTE_MAX_LENGTH}
              aria-invalid={showError && invalid ? true : undefined}
              aria-describedby={showError && invalid ? errorId : undefined}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>
        {showError && invalid ? (
          <p id={errorId} role="alert" className="message-reports__error">
            {t("adminSchool.aiReports.note.required")}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={onClose}>
          {t("adminSchool.aiReports.cancel")}
        </Button>
        <Button
          type="button"
          loading={submitting}
          onClick={() => {
            if (!target) return;
            if (invalid) {
              setShowError(true);
              return;
            }
            onSubmit(target, trimmed);
          }}
        >
          {target ? t(`adminSchool.aiReports.note.submit.${target}`) : ""}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * One AI content report (`/portal/admin/ai-reports/:reportId`), gated on `aiContent:moderate`.
 * Shows who and what was reported and why, the reported output itself (hidden until the moderator
 * chooses to read it — it may be harmful), and the review workflow: start review, escalate (to the
 * authorities or Studafy, with the reference), mark actioned, or dismiss.
 */
export default function AiReportDetailPage() {
  const { reportId = "" } = useParams<{ reportId: string }>();
  const { t } = useTranslation();
  usePortalBack("/portal/admin/ai-reports");
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const [revealed, setRevealed] = useState(false);
  const [target, setTarget] = useState<CloseTarget | null>(null);
  const query = useAiReport(reportId);
  const review = useReviewAiReport(reportId);
  const names = useStudentNames(query.data ? [query.data.student_id] : []);

  const when = (iso: string) =>
    formatDate(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  if (query.isPending) return <p role="status">{t("adminSchool.aiReports.loading")}</p>;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <p role="alert">
        {notFound ? t("adminSchool.aiReports.notFound") : t("adminSchool.aiReports.loadError")}
      </p>
    );
  }

  const report = query.data;
  const transitions = AI_REPORT_TRANSITIONS[report.status];

  function submit(input: ReviewAiReportInput) {
    review.mutate(input, {
      onSuccess: () => {
        show({ variant: "success", title: t(`adminSchool.aiReports.toast.${input.status}`) });
        setTarget(null);
      },
      onError: (error) => {
        const conflict = error instanceof ApiError && error.status === 409;
        show({
          variant: "error",
          title: conflict
            ? t("adminSchool.aiReports.conflict")
            : t("adminSchool.aiReports.updateFailed"),
          description: conflict ? undefined : apiErrorDescription(error),
        });
        if (conflict) setTarget(null);
      },
    });
  }

  return (
    <>
      <h1>{t(`adminSchool.aiReports.reason.${report.reason_category}`)}</h1>

      {report.overdue ? (
        <p className="message-reports__overdue-banner" role="note">
          {t("adminSchool.aiReports.overdueWarning", { time: when(report.respond_by) })}
        </p>
      ) : null}

      <dl className="message-reports__summary">
        <div>
          <dt>{t("adminSchool.aiReports.columns.priority")}</dt>
          <dd>
            <span className="message-reports__pill" data-tone={aiPriorityTone(report.priority)}>
              {t(`adminSchool.aiReports.priority.${report.priority}`)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t("adminSchool.aiReports.columns.status")}</dt>
          <dd>
            <span className="message-reports__pill" data-tone={aiStatusTone(report.status)}>
              {t(`adminSchool.aiReports.status.${report.status}`)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t("adminSchool.aiReports.detail.respondBy")}</dt>
          <dd data-overdue={report.overdue ? "true" : undefined}>{when(report.respond_by)}</dd>
        </div>
        <div>
          <dt>{t("adminSchool.aiReports.columns.student")}</dt>
          <dd>{names.get(report.student_id) ?? "…"}</dd>
        </div>
        <div>
          <dt>{t("adminSchool.aiReports.columns.content")}</dt>
          <dd>{t(`adminSchool.aiReports.contentType.${report.content_type}`)}</dd>
        </div>
        <div>
          <dt>{t("adminSchool.aiReports.detail.source")}</dt>
          <dd>{t(`adminSchool.aiReports.source.${report.source}`)}</dd>
        </div>
        <div>
          <dt>{t("adminSchool.aiReports.columns.filed")}</dt>
          <dd>{when(report.created_at)}</dd>
        </div>
      </dl>

      <section className="message-reports__section" aria-labelledby="ai-report-reason">
        <h2 id="ai-report-reason">{t("adminSchool.aiReports.detail.studentSaid")}</h2>
        <p className="message-reports__details-text">
          {report.reason ?? t("adminSchool.aiReports.detail.noReason")}
        </p>
      </section>

      <section className="message-reports__section" aria-labelledby="ai-report-content">
        <div className="message-reports__section-header">
          <h2 id="ai-report-content">{t("adminSchool.aiReports.detail.content")}</h2>
          <Button
            type="button"
            variant="tertiary"
            aria-expanded={revealed}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed
              ? t("adminSchool.aiReports.detail.hideContent")
              : t("adminSchool.aiReports.detail.showContent")}
          </Button>
        </div>
        {revealed ? (
          <p className="ai-reports__snapshot">{report.content_snapshot}</p>
        ) : (
          <p className="message-reports__hint">{t("adminSchool.aiReports.detail.contentHidden")}</p>
        )}
      </section>

      <section className="message-reports__section" aria-labelledby="ai-report-review">
        <h2 id="ai-report-review">{t("adminSchool.aiReports.detail.review")}</h2>
        {report.resolution_note ? (
          <p className="message-reports__details-text">
            {t("adminSchool.aiReports.detail.note", { note: report.resolution_note })}
          </p>
        ) : null}
        {report.reviewed_at ? (
          <p className="message-reports__hint">
            {t("adminSchool.aiReports.detail.reviewedAt", { time: when(report.reviewed_at) })}
          </p>
        ) : null}
        {transitions.length > 0 ? (
          <div className="message-reports__actions">
            {transitions.includes("in_review") ? (
              <Button
                type="button"
                variant="secondary"
                loading={review.isPending && review.variables?.status === "in_review"}
                disabled={review.isPending}
                onClick={() => submit({ status: "in_review" })}
              >
                {t("adminSchool.aiReports.detail.startReview")}
              </Button>
            ) : null}
            {CLOSE_TARGETS.filter((status) => transitions.includes(status)).map((status) => (
              <Button
                key={status}
                type="button"
                variant={status === "actioned" ? "primary" : "secondary"}
                disabled={review.isPending}
                onClick={() => setTarget(status)}
              >
                {t(`adminSchool.aiReports.detail.action.${status}`)}
              </Button>
            ))}
          </div>
        ) : null}
      </section>

      <NoteModal
        target={target}
        submitting={review.isPending}
        onClose={() => setTarget(null)}
        onSubmit={(status, note) => submit({ status, resolution_note: note })}
      />
    </>
  );
}
