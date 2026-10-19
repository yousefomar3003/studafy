import { ApiError } from "@studafy/api-client";
import { Button, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { DATE_TIME_OPTIONS } from "../format";

import {
  decodeHtmlEntities,
  MESSAGE_REPORT_PRIORITY_LABEL_KEYS,
  MESSAGE_REPORT_REASON_LABEL_KEYS,
  MESSAGE_REPORT_ROLE_LABEL_KEYS,
  MESSAGE_REPORT_STATUS_LABEL_KEYS,
  MESSAGE_REPORT_TRANSITIONS,
  priorityTone,
  statusTone,
} from "./labels";
import { useUpdateMessageReport } from "./mutations";
import { fetchMessageReport, messageReportKey } from "./queries";
import { ResolveReportModal } from "./ResolveReportModal";

import type { UpdateMessageReportInput } from "./mutations";
import type {
  MessageReportDetail,
  MessageReportEvidenceAttachment,
  MessageReportEvidenceMessage,
} from "./queries";
import type { ResolutionTarget } from "./ResolveReportModal";

import "./message-reports.css";

const SUCCESS_TOAST_KEYS: Record<UpdateMessageReportInput["status"], string> = {
  in_review: "principal.messageReports.detail.toast.in_review",
  actioned: "principal.messageReports.detail.toast.actioned",
  dismissed: "principal.messageReports.detail.toast.dismissed",
};

function apiErrorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

function isInvalidTransition(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "MESSAGE_REPORT_INVALID_TRANSITION" || error.status === 409)
  );
}

interface AttachmentThumbnailProps {
  attachment: MessageReportEvidenceAttachment;
  senderName: string;
}

function AttachmentThumbnail({ attachment, senderName }: AttachmentThumbnailProps) {
  const { t } = useTranslation();
  if (!attachment.download_url) {
    return (
      <span className="message-reports__image-unavailable">
        {t("principal.messageReports.detail.imageUnavailable")}
      </span>
    );
  }
  return (
    <a
      className="message-reports__thumbnail"
      href={attachment.download_url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("principal.messageReports.detail.openImage", { name: senderName })}
    >
      <img
        src={attachment.download_url}
        alt={t("principal.messageReports.detail.imageAlt", { name: senderName })}
        loading="lazy"
      />
    </a>
  );
}

interface TranscriptProps {
  report: MessageReportDetail;
  messages: readonly MessageReportEvidenceMessage[];
}

function Transcript({ report, messages }: TranscriptProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();

  if (messages.length === 0) {
    return (
      <p className="message-reports__hint">
        {t("principal.messageReports.detail.transcriptEmpty")}
      </p>
    );
  }

  return (
    <ol
      className="message-reports__transcript"
      aria-label={t("principal.messageReports.detail.transcript")}
    >
      {messages.map((message) => {
        const side =
          message.sender_id === report.reported.id
            ? "reported"
            : message.sender_id === report.reporter.id
              ? "reporter"
              : "other";
        const senderName = decodeHtmlEntities(message.sender_name);
        return (
          <li
            key={message.id}
            className="message-reports__message"
            data-side={side}
            data-reported={message.is_reported ? "true" : undefined}
          >
            <div className="message-reports__message-meta">
              <span className="message-reports__message-sender">{senderName}</span>
              <time dateTime={message.created_at}>
                {formatDate(new Date(message.created_at), DATE_TIME_OPTIONS)}
              </time>
              {message.is_reported ? (
                <span className="message-reports__pill" data-tone="danger">
                  {t("principal.messageReports.detail.reportedMessage")}
                </span>
              ) : null}
            </div>
            {message.body ? (
              <p className="message-reports__message-body">{decodeHtmlEntities(message.body)}</p>
            ) : null}
            {message.attachments.length > 0 ? (
              <div className="message-reports__attachments">
                {message.attachments.map((attachment) => (
                  <AttachmentThumbnail
                    key={attachment.id}
                    attachment={attachment}
                    senderName={senderName}
                  />
                ))}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Message report detail (`/portal/principal/message-reports/:reportId`), gated on
 * `messageReport:review`. Shows the report, the evidence transcript snapshotted when it was filed
 * (oldest first, the reported message highlighted), and the review workflow: start review, then
 * close as actioned or dismissed with a required resolution note.
 *
 * Message bodies arrive HTML-escaped by the API's sanitizer; they are decoded and rendered as
 * plain text nodes, never as markup. Attachment URLs are pre-signed for five minutes, so "Refresh
 * images" refetches the report to mint fresh ones.
 */
export default function MessageReportDetailPage() {
  const { reportId = "" } = useParams<{ reportId: string }>();
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const [resolveTarget, setResolveTarget] = useState<ResolutionTarget | null>(null);

  const reportQuery = useQuery({
    queryKey: messageReportKey(reportId),
    queryFn: () => fetchMessageReport(reportId),
  });
  const update = useUpdateMessageReport(reportId);

  const formatDateTime = (iso: string) => formatDate(new Date(iso), DATE_TIME_OPTIONS);

  if (reportQuery.isPending) {
    return (
      <>
        <p role="status">{t("principal.common.loading")}</p>
      </>
    );
  }

  if (reportQuery.isError || !reportQuery.data) {
    const notFound = reportQuery.error instanceof ApiError && reportQuery.error.status === 404;
    return (
      <>
        <p role="alert">
          {notFound
            ? t("principal.messageReports.detail.notFound")
            : t("principal.messageReports.detail.loadError")}
        </p>
      </>
    );
  }

  const report = reportQuery.data;
  const transitions = MESSAGE_REPORT_TRANSITIONS[report.status];
  const isClosed = transitions.length === 0;
  const hasImages = report.messages.some((message) => message.attachments.length > 0);

  const party = (person: MessageReportDetail["reporter"]) =>
    t("principal.messageReports.party", {
      name: person.name,
      role: t(MESSAGE_REPORT_ROLE_LABEL_KEYS[person.role]),
    });

  function submit(input: UpdateMessageReportInput) {
    update.mutate(input, {
      onSuccess: () => {
        show({ variant: "success", title: t(SUCCESS_TOAST_KEYS[input.status]) });
        setResolveTarget(null);
      },
      onError: (error) => {
        if (isInvalidTransition(error)) {
          // Someone else already moved this report; the mutation's onSettled refetches it.
          show({
            variant: "error",
            title: t("principal.messageReports.detail.conflictTitle"),
            description: t("principal.messageReports.detail.conflictDescription"),
          });
          setResolveTarget(null);
          return;
        }
        show({
          variant: "error",
          title: t("principal.messageReports.detail.updateFailed"),
          description: apiErrorDescription(error),
        });
      },
    });
  }

  return (
    <>
      <h1>{t(MESSAGE_REPORT_REASON_LABEL_KEYS[report.reason_category])}</h1>

      {report.is_overdue ? (
        <p className="message-reports__overdue-banner" role="note">
          {t("principal.messageReports.detail.overdueWarning", {
            time: formatDateTime(report.respond_by),
          })}
        </p>
      ) : null}

      <dl className="message-reports__summary">
        <div>
          <dt>{t("principal.messageReports.detail.priority")}</dt>
          <dd>
            <span className="message-reports__pill" data-tone={priorityTone(report.priority)}>
              {t(MESSAGE_REPORT_PRIORITY_LABEL_KEYS[report.priority])}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t("principal.messageReports.detail.status")}</dt>
          <dd>
            <span className="message-reports__pill" data-tone={statusTone(report.status)}>
              {t(MESSAGE_REPORT_STATUS_LABEL_KEYS[report.status])}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t("principal.messageReports.detail.respondBy")}</dt>
          <dd data-overdue={report.is_overdue ? "true" : undefined}>
            {formatDateTime(report.respond_by)}
          </dd>
        </div>
        <div>
          <dt>{t("principal.messageReports.detail.reporter")}</dt>
          <dd>{party(report.reporter)}</dd>
        </div>
        <div>
          <dt>{t("principal.messageReports.detail.reported")}</dt>
          <dd>{party(report.reported)}</dd>
        </div>
        <div>
          <dt>{t("principal.messageReports.detail.student")}</dt>
          <dd>{report.student.name}</dd>
        </div>
        <div>
          <dt>{t("principal.messageReports.detail.createdAt")}</dt>
          <dd>{formatDateTime(report.created_at)}</dd>
        </div>
        <div>
          <dt>{t("principal.messageReports.detail.block")}</dt>
          <dd>
            {report.block_exists
              ? t("principal.messageReports.detail.blockYes")
              : t("principal.messageReports.detail.blockNo")}
          </dd>
        </div>
      </dl>

      <section className="message-reports__section" aria-labelledby="message-report-details">
        <h2 id="message-report-details">{t("principal.messageReports.detail.details")}</h2>
        <p className="message-reports__details-text">
          {report.details
            ? decodeHtmlEntities(report.details)
            : t("principal.messageReports.detail.noDetails")}
        </p>
      </section>

      <section className="message-reports__section" aria-labelledby="message-report-review">
        <h2 id="message-report-review">{t("principal.messageReports.detail.review")}</h2>
        {isClosed ? (
          <dl className="message-reports__summary">
            <div>
              <dt>{t("principal.messageReports.detail.resolutionNote")}</dt>
              <dd className="message-reports__details-text">
                {report.resolution_note ? decodeHtmlEntities(report.resolution_note) : "—"}
              </dd>
            </div>
            <div>
              <dt>{t("principal.messageReports.detail.reviewedBy")}</dt>
              <dd>{report.reviewed_by?.name ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("principal.messageReports.detail.reviewedAt")}</dt>
              <dd>{report.reviewed_at ? formatDateTime(report.reviewed_at) : "—"}</dd>
            </div>
          </dl>
        ) : (
          <>
            <div className="message-reports__actions">
              {transitions.includes("in_review") ? (
                <Button
                  type="button"
                  variant="secondary"
                  loading={update.isPending && update.variables?.status === "in_review"}
                  disabled={update.isPending}
                  onClick={() => submit({ status: "in_review" })}
                >
                  {t("principal.messageReports.detail.startReview")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="primary"
                disabled={update.isPending}
                onClick={() => setResolveTarget("actioned")}
              >
                {t("principal.messageReports.detail.markActioned")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={update.isPending}
                onClick={() => setResolveTarget("dismissed")}
              >
                {t("principal.messageReports.detail.dismiss")}
              </Button>
            </div>
            {report.reviewed_by ? (
              <p className="message-reports__hint">
                {t("principal.messageReports.detail.inReviewBy", {
                  name: report.reviewed_by.name,
                })}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="message-reports__section" aria-labelledby="message-report-transcript">
        <div className="message-reports__section-header">
          <h2 id="message-report-transcript">{t("principal.messageReports.detail.transcript")}</h2>
          {hasImages ? (
            <Button
              type="button"
              variant="tertiary"
              loading={reportQuery.isFetching}
              onClick={() => void reportQuery.refetch()}
            >
              {t("principal.messageReports.detail.refreshImages")}
            </Button>
          ) : null}
        </div>
        <p className="message-reports__hint">
          {hasImages
            ? t("principal.messageReports.detail.transcriptHintImages")
            : t("principal.messageReports.detail.transcriptHint")}
        </p>
        <Transcript report={report} messages={report.messages} />
      </section>

      <ResolveReportModal
        target={resolveTarget}
        submitting={update.isPending}
        onClose={() => setResolveTarget(null)}
        onSubmit={(status, note) => submit({ status, resolution_note: note })}
      />
    </>
  );
}
