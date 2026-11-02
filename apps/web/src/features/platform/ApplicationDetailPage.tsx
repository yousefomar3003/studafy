import { ApiError } from "@studafy/api-client";
import { Button, Card, Modal, useToast } from "@studafy/ui";
import { useId, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { useApplicationQuery, useApproveApplication, useRejectApplication } from "./applications";
import { ApplicationStatusPill } from "./ApplicationsPage";
import { PlatformPageHeader } from "./PlatformNav";

import "./platform.css";

import type { PlatformApplication } from "./applications";

type Decision = "approve" | "reject";

/**
 * One school sign-up application (`/portal/platform/applications/:applicationId`): everything the
 * applicant filled in, their proof of ownership, and the approve / reject decision. Approving
 * creates the school with the applicant as its admin; either decision is emailed to them.
 */
export default function ApplicationDetailPage() {
  const { applicationId = "" } = useParams();
  const { t } = useTranslation();
  const { data: application, isPending, isError } = useApplicationQuery(applicationId);
  const [decision, setDecision] = useState<Decision | null>(null);

  if (isPending) {
    return <p role="status">{t("site.common.loading")}</p>;
  }
  if (isError || !application) {
    return (
      <>
        <p role="alert">{t("platform.applications.detail.loadError")}</p>
        <Link to="/portal/platform/applications">{t("platform.applications.detail.back")}</Link>
      </>
    );
  }

  return (
    <>
      <PlatformPageHeader
        title={application.schoolName}
        description={`${application.city}, ${application.countryName}`}
        actions={<ApplicationStatusPill status={application.status} />}
      />
      <p>
        <Link to="/portal/platform/applications">{t("platform.applications.detail.back")}</Link>
      </p>

      <div className="platform-grid">
        <SchoolCard application={application} />
        <ApplicantCard application={application} />
        <ProofCard application={application} />
      </div>

      <div className="platform-stack">
        {application.message ? (
          <Card as="section" aria-labelledby="application-message-title">
            <Card.Header>
              <h2 id="application-message-title">{t("platform.applications.detail.message")}</h2>
            </Card.Header>
            <Card.Body>
              <p className="platform-inquiry-message">{application.message}</p>
            </Card.Body>
          </Card>
        ) : null}
        <DecisionCard application={application} onDecide={setDecision} />
      </div>

      <DecisionDialog
        application={application}
        decision={decision}
        onClose={() => setDecision(null)}
      />
    </>
  );
}

function SchoolCard({ application }: { application: PlatformApplication }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const dash = (value: string | null) => value ?? "—";
  return (
    <Card as="section" aria-labelledby="application-school-title">
      <Card.Header>
        <h2 id="application-school-title">{t("platform.applications.detail.school")}</h2>
      </Card.Header>
      <Card.Body>
        <dl className="platform-dl">
          <dt>{t("platform.applications.detail.schoolName")}</dt>
          <dd>{application.schoolName}</dd>
          <dt>{t("platform.applications.detail.country")}</dt>
          <dd>{`${application.countryName} (${application.countryCode})`}</dd>
          <dt>{t("platform.applications.detail.city")}</dt>
          <dd>{application.city}</dd>
          <dt>{t("platform.applications.detail.address")}</dt>
          <dd>{application.address}</dd>
          <dt>{t("platform.applications.detail.schoolEmail")}</dt>
          <dd>{dash(application.schoolEmail)}</dd>
          <dt>{t("platform.applications.detail.website")}</dt>
          <dd>
            {application.website ? (
              <a href={toHref(application.website)} target="_blank" rel="noreferrer noopener">
                {application.website}
              </a>
            ) : (
              "—"
            )}
          </dd>
          <dt>{t("platform.applications.detail.students")}</dt>
          <dd>
            {application.studentCount === null ? "—" : formatNumber(application.studentCount)}
          </dd>
          <dt>{t("platform.applications.detail.currency")}</dt>
          <dd>{application.currencyCode}</dd>
        </dl>
      </Card.Body>
    </Card>
  );
}

function ApplicantCard({ application }: { application: PlatformApplication }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const when = (value: string | null) =>
    value
      ? formatDate(new Date(value), { dateStyle: "medium", timeStyle: "short" })
      : t("platform.applications.detail.notYet");
  return (
    <Card as="section" aria-labelledby="application-applicant-title">
      <Card.Header>
        <h2 id="application-applicant-title">{t("platform.applications.detail.applicant")}</h2>
      </Card.Header>
      <Card.Body>
        <dl className="platform-dl">
          <dt>{t("platform.applications.detail.name")}</dt>
          <dd>{application.applicantName}</dd>
          <dt>{t("platform.applications.detail.jobTitle")}</dt>
          <dd>{application.applicantJobTitle ?? "—"}</dd>
          <dt>{t("platform.applications.detail.email")}</dt>
          <dd>
            <a href={`mailto:${application.applicantEmail}`}>{application.applicantEmail}</a>
          </dd>
          <dt>{t("platform.applications.detail.phone")}</dt>
          <dd>
            <a href={`tel:${application.applicantPhone}`}>{application.applicantPhone}</a>
          </dd>
          <dt>{t("platform.applications.detail.provider")}</dt>
          <dd>
            {t(`platform.applications.provider.${application.provider}`, {
              defaultValue: application.provider,
            })}
          </dd>
          <dt>{t("platform.applications.detail.received")}</dt>
          <dd>{when(application.createdAt)}</dd>
          <dt>{t("platform.applications.detail.teamEmailed")}</dt>
          <dd>{when(application.teamNotifiedAt)}</dd>
        </dl>
      </Card.Body>
    </Card>
  );
}

function ProofCard({ application }: { application: PlatformApplication }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const { proof } = application;
  const isImage = proof.contentType.startsWith("image/");
  return (
    <Card as="section" aria-labelledby="application-proof-title">
      <Card.Header>
        <h2 id="application-proof-title">{t("platform.applications.detail.proof")}</h2>
      </Card.Header>
      <Card.Body>
        <p>
          {proof.fileName}{" "}
          <span className="platform-muted">
            {t("platform.applications.detail.proofSize", {
              size: formatNumber(Math.max(1, Math.round(proof.sizeBytes / 1024))),
            })}
          </span>
        </p>
        {proof.url ? (
          <>
            {isImage ? (
              <img
                className="platform-application-proof"
                src={proof.url}
                alt={t("platform.applications.detail.proofAlt", {
                  school: application.schoolName,
                })}
              />
            ) : null}
            <a href={proof.url} target="_blank" rel="noreferrer noopener">
              {t("platform.applications.detail.openProof")}
            </a>
          </>
        ) : (
          <p className="platform-muted">{t("platform.applications.detail.proofUnavailable")}</p>
        )}
      </Card.Body>
    </Card>
  );
}

function DecisionCard({
  application,
  onDecide,
}: {
  application: PlatformApplication;
  onDecide: (decision: Decision) => void;
}) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  return (
    <Card as="section" aria-labelledby="application-decision-title">
      <Card.Header>
        <h2 id="application-decision-title">{t("platform.applications.detail.decision")}</h2>
      </Card.Header>
      <Card.Body>
        {application.status === "pending" ? (
          <>
            <p>{t("platform.applications.detail.decisionExplain")}</p>
            <div className="platform-actions">
              <Button variant="primary" onClick={() => onDecide("approve")}>
                {t("platform.applications.actions.approve")}
              </Button>
              <Button variant="secondary" onClick={() => onDecide("reject")}>
                {t("platform.applications.actions.reject")}
              </Button>
            </div>
          </>
        ) : (
          <dl className="platform-dl">
            <dt>{t("platform.applications.columns.status")}</dt>
            <dd>
              <ApplicationStatusPill status={application.status} />
            </dd>
            <dt>{t("platform.applications.detail.reviewedAt")}</dt>
            <dd>
              {application.reviewedAt
                ? formatDate(new Date(application.reviewedAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : "—"}
            </dd>
            <dt>{t("platform.applications.detail.reviewNote")}</dt>
            <dd>{application.reviewNote ?? "—"}</dd>
            <dt>{t("platform.applications.detail.applicantEmailed")}</dt>
            <dd>
              {application.applicantNotifiedAt
                ? formatDate(new Date(application.applicantNotifiedAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : t("platform.applications.detail.notYet")}
            </dd>
            {application.schoolId ? (
              <>
                <dt>{t("platform.applications.detail.createdSchool")}</dt>
                <dd>
                  <Link to={`/portal/platform/schools/${application.schoolId}`}>
                    {application.schoolName}
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>
        )}
      </Card.Body>
    </Card>
  );
}

/** Approve (optional note) or reject (required reason, emailed to the applicant). */
function DecisionDialog({
  application,
  decision,
  onClose,
}: {
  application: PlatformApplication;
  decision: Decision | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const approve = useApproveApplication();
  const reject = useRejectApplication();
  const textId = useId();
  const [text, setText] = useState("");
  const mutation = decision === "reject" ? reject : approve;

  if (!decision) return null;

  const close = () => {
    setText("");
    approve.reset();
    reject.reset();
    onClose();
  };
  const submit = () =>
    mutation.mutate(
      { applicationId: application.id, text: text.trim() },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t(`platform.applications.${decision}.done`, {
              school: application.schoolName,
            }),
          });
          close();
        },
      },
    );

  const errorCode = mutation.error instanceof ApiError ? mutation.error.code : null;
  const canSubmit = decision === "approve" || text.trim().length > 0;

  return (
    <Modal
      open
      onClose={close}
      title={t(`platform.applications.${decision}.title`, { school: application.schoolName })}
      description={t(`platform.applications.${decision}.description`, {
        email: application.applicantEmail,
      })}
    >
      <Modal.Body>
        <div className="sf-field">
          <label className="sf-field__label" htmlFor={textId}>
            {t(`platform.applications.${decision}.label`)}
          </label>
          <div className="sf-input platform-inquiry-notes">
            <textarea
              id={textId}
              className="sf-input__control"
              rows={4}
              maxLength={2000}
              required={decision === "reject"}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
        </div>
        {mutation.isError ? (
          <p role="alert">
            {t(`platform.applications.errors.${errorCode ?? "generic"}`, {
              defaultValue: t("platform.applications.errors.generic"),
            })}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant={decision === "approve" ? "primary" : "secondary"}
          disabled={!canSubmit}
          loading={mutation.isPending}
          onClick={submit}
        >
          {t(`platform.applications.actions.${decision}`)}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function toHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}
