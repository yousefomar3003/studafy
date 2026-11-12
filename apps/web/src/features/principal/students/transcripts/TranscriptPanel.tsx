import { PERMISSIONS } from "@studafy/constants";
import { Button, Card, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link } from "react-router-dom";

import { usePermissions } from "../../../../lib/auth";
import { useFormatters, useTranslation } from "../../../../lib/i18n";
import { Badge, Num, Percent, ReasonModal } from "../../academic-setup/components";
import { problemMessage } from "../../academic-setup/errors";

import {
  useIssueTranscript,
  useReissueTranscript,
  useRevokeTranscript,
  useStudentTranscripts,
  useTranscriptReadiness,
} from "./queries";

import type { AcademicTranscript, TranscriptReadiness } from "./queries";
import type { BadgeTone } from "../../academic-setup/components";

import "../../academic-setup/academic-setup.css";
import "./transcripts.css";

const STATE_TONE: Record<TranscriptReadiness["state"], BadgeTone> = {
  ready: "info",
  issued: "success",
  needs_reissue: "warning",
  blocked: "neutral",
};

export function transcriptHref(studentId: string, transcriptId: string): string {
  return `/portal/principal/students/${studentId}/transcripts/${transcriptId}`;
}

/**
 * A student's academic transcript on the principal's student page: what issuing one would cover
 * (every finalized end-of-year result, oldest first, with the cumulative average and GPA), the
 * transcripts already issued, and — for leadership that may issue certificates — issue, reissue and
 * revoke. Every figure comes from the API; nothing is computed here.
 */
export function TranscriptPanel({ studentId }: { studentId: string }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const permissions = usePermissions();
  const canIssue = permissions.has(PERMISSIONS.ACADEMIC_CERTIFICATE_ISSUE);
  const readiness = useTranscriptReadiness(studentId, canIssue);
  const transcripts = useStudentTranscripts(studentId);
  const issue = useIssueTranscript(studentId);
  const reissue = useReissueTranscript(studentId);
  const revoke = useRevokeTranscript(studentId);
  const [reasonFor, setReasonFor] = useState<{
    transcript: AcademicTranscript;
    action: "reissue" | "revoke";
  } | null>(null);

  const day = (iso: string) => formatDate(new Date(iso), { dateStyle: "medium" });
  const current = transcripts.data?.find((transcript) => transcript.status === "issued");

  function issueNow() {
    issue.mutate(undefined, {
      onSuccess: () =>
        show({ variant: "success", title: t("principal.students.transcripts.issuedToast") }),
      onError: (error) =>
        show({
          variant: "error",
          title: t("principal.students.transcripts.actionFailed"),
          description: problemMessage(error, t),
        }),
    });
  }

  function decide(reason: string) {
    if (!reasonFor) return;
    const mutation = reasonFor.action === "reissue" ? reissue : revoke;
    mutation.mutate(
      { transcriptId: reasonFor.transcript.id, reason },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t(`principal.students.transcripts.${reasonFor.action}dToast`),
          });
          setReasonFor(null);
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("principal.students.transcripts.actionFailed"),
            description: problemMessage(error, t),
          }),
      },
    );
  }

  return (
    <Card as="section" aria-labelledby="student-transcript-heading">
      <Card.Header>
        <h2 id="student-transcript-heading">{t("principal.students.transcripts.heading")}</h2>
      </Card.Header>
      <Card.Body>
        <p className="ag-muted">{t("principal.students.transcripts.intro")}</p>

        {canIssue ? (
          readiness.isPending ? (
            <p role="status">{t("principal.common.loading")}</p>
          ) : readiness.isError ? (
            <p role="alert">{problemMessage(readiness.error, t)}</p>
          ) : (
            <div className="ag-transcript-readiness">
              <p>
                <Badge tone={STATE_TONE[readiness.data.state]}>
                  {t(`principal.students.transcripts.state.${readiness.data.state}`)}
                </Badge>
              </p>
              {readiness.data.years.length > 0 ? (
                <p>
                  {t("principal.students.transcripts.covers", {
                    count: readiness.data.years.length,
                    years: readiness.data.years
                      .map((year) =>
                        t("principal.students.transcripts.yearItem", {
                          grade: year.grade_level_name,
                          year: year.academic_year_name,
                        }),
                      )
                      .join(", "),
                  })}
                </p>
              ) : null}
              {readiness.data.cumulative ? (
                <dl className="ag-certificate__facts">
                  <div>
                    <dt>{t("academicGrading.transcript.cumulativeAverage")}</dt>
                    <dd>
                      <Percent value={readiness.data.cumulative.average_percentage} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t("academicGrading.transcript.cumulativeGpa")}</dt>
                    <dd>
                      {readiness.data.cumulative.gpa === null ? (
                        t("academicGrading.transcript.gpaUnavailable")
                      ) : (
                        <Num value={readiness.data.cumulative.gpa} />
                      )}
                    </dd>
                  </div>
                </dl>
              ) : null}
              {readiness.data.reasons.length > 0 ? (
                <ul>
                  {readiness.data.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
              {readiness.data.state === "ready" ? (
                <Button type="button" loading={issue.isPending} onClick={issueNow}>
                  {t("principal.students.transcripts.issue")}
                </Button>
              ) : null}
              {readiness.data.state === "needs_reissue" && current ? (
                <Button
                  type="button"
                  onClick={() => setReasonFor({ transcript: current, action: "reissue" })}
                >
                  {t("principal.students.transcripts.reissue")}
                </Button>
              ) : null}
            </div>
          )
        ) : null}

        {transcripts.isPending ? (
          <p role="status">{t("principal.common.loading")}</p>
        ) : transcripts.isError ? (
          <p role="alert">{t("principal.students.transcripts.error")}</p>
        ) : transcripts.data.length === 0 ? (
          <p>{t("principal.students.transcripts.empty")}</p>
        ) : (
          <ul aria-label={t("principal.students.transcripts.listLabel")}>
            {transcripts.data.map((transcript) => (
              <li key={transcript.id}>
                <Link to={transcriptHref(studentId, transcript.id)}>
                  {t("principal.students.transcripts.item", {
                    serial: transcript.serial_number,
                    date: day(transcript.issued_at),
                  })}
                </Link>
                {transcript.status === "issued"
                  ? null
                  : ` (${t(`principal.students.transcripts.status.${transcript.status}`)})`}
                {transcript.stale_reasons.map((reason) => (
                  <span key={reason}>
                    {" "}
                    <Badge tone="warning">
                      {t(`principal.students.transcripts.stale.${reason}`)}
                    </Badge>
                  </span>
                ))}
                {canIssue && transcript.status === "issued" ? (
                  <>
                    {" "}
                    <Button
                      type="button"
                      variant="tertiary"
                      aria-label={t("principal.students.transcripts.revokeLabel", {
                        serial: transcript.serial_number,
                      })}
                      onClick={() => setReasonFor({ transcript, action: "revoke" })}
                    >
                      {t("principal.students.transcripts.revoke")}
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card.Body>

      {reasonFor ? (
        <ReasonModal
          key={`${reasonFor.transcript.id}-${reasonFor.action}`}
          open
          title={t(`principal.students.transcripts.${reasonFor.action}Title`, {
            serial: reasonFor.transcript.serial_number,
          })}
          description={t(`principal.students.transcripts.${reasonFor.action}Description`)}
          confirmLabel={t(`principal.students.transcripts.${reasonFor.action}`)}
          submitting={reissue.isPending || revoke.isPending}
          onCancel={() => setReasonFor(null)}
          onConfirm={decide}
        />
      ) : null}
    </Card>
  );
}
