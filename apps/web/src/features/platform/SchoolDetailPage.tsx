import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { SchoolLicenseSection } from "./licensing/SchoolLicenseSection";
import { useChangeSchoolStatus, useSetFeatureFlag } from "./mutations";
import { PlatformPageHeader, SchoolStatusPill } from "./PlatformNav";
import { useSchoolDetailQuery } from "./queries";
import { SchoolMembersCard } from "./SchoolMembersCard";

import "./platform.css";

import type {
  PlatformFeatureFlagState,
  PlatformSchoolDetail,
  PlatformSchoolStatus,
} from "./queries";
import type { SelectOption } from "@studafy/ui";

type FlagChoice = "default" | "on" | "off";

/**
 * One school's platform record (`/portal/platform/schools/:schoolId`): identity, subscription,
 * headcount by role (students, teachers and parents first, with their member-code prefix), lifecycle actions, the school's members and per-school feature-flag overrides.
 */
export default function SchoolDetailPage() {
  const { schoolId = "" } = useParams();
  const { t } = useTranslation();
  const { data: school, isPending, isError } = useSchoolDetailQuery(schoolId);
  const [target, setTarget] = useState<PlatformSchoolStatus | null>(null);

  if (isPending) {
    return <p role="status">{t("site.common.loading")}</p>;
  }
  if (isError || !school) {
    return (
      <>
        <p role="alert">{t("platform.school.loadError")}</p>
        <Link to="/portal/platform/schools">{t("platform.school.back")}</Link>
      </>
    );
  }

  return (
    <>
      <PlatformPageHeader
        title={school.name}
        description={`${school.slug} · ${school.email}`}
        actions={<SchoolStatusPill status={school.status} />}
      />
      <p>
        <Link to="/portal/platform/schools">{t("platform.school.back")}</Link>
      </p>

      <div className="platform-grid">
        <ProfileCard school={school} />
        <SubscriptionCard school={school} />
        <PeopleCard school={school} />
      </div>

      <div className="platform-stack">
        <Card as="section" aria-labelledby="platform-lifecycle-title">
          <Card.Header>
            <h2 id="platform-lifecycle-title">{t("platform.school.lifecycle.title")}</h2>
          </Card.Header>
          <Card.Body>
            <p>{t(`platform.school.lifecycle.explain.${school.status}`)}</p>
            {school.allowedTransitions.length === 0 ? (
              <p className="platform-muted">{t("platform.school.lifecycle.terminal")}</p>
            ) : (
              <div className="platform-actions">
                {school.allowedTransitions.map((status) => (
                  <Button
                    key={status}
                    variant={status === "active" ? "primary" : "secondary"}
                    onClick={() => setTarget(status)}
                  >
                    {t(`platform.school.lifecycle.actions.${status}`)}
                  </Button>
                ))}
              </div>
            )}
          </Card.Body>
        </Card>

        <SchoolMembersCard school={school} />

        <SchoolLicenseSection schoolId={school.id} schoolName={school.name} />

        <FeatureFlagsCard school={school} />
      </div>

      <ChangeStatusDialog school={school} target={target} onClose={() => setTarget(null)} />
    </>
  );
}

function ProfileCard({ school }: { school: PlatformSchoolDetail }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const date = (value: string | null) =>
    value ? formatDate(new Date(value), { dateStyle: "medium" }) : t("platform.common.never");

  return (
    <Card as="section" aria-labelledby="platform-profile-title">
      <Card.Header>
        <h2 id="platform-profile-title">{t("platform.school.profile.title")}</h2>
      </Card.Header>
      <Card.Body>
        <dl className="platform-dl">
          <dt>{t("platform.school.profile.id")}</dt>
          <dd>
            <code>{school.id}</code>
          </dd>
          <dt>{t("platform.school.profile.schoolNumber")}</dt>
          <dd>{school.schoolNumber}</dd>
          <dt>{t("platform.school.profile.region")}</dt>
          <dd>{`${school.countryCode} · ${school.currencyCode}`}</dd>
          <dt>{t("platform.school.profile.created")}</dt>
          <dd>{date(school.createdAt)}</dd>
          <dt>{t("platform.school.profile.emailVerified")}</dt>
          <dd>{date(school.emailVerifiedAt)}</dd>
          {school.isReviewTenant ? (
            <>
              <dt>{t("platform.school.profile.reviewTenant")}</dt>
              <dd>{t("platform.common.yes")}</dd>
            </>
          ) : null}
        </dl>
      </Card.Body>
    </Card>
  );
}

function SubscriptionCard({ school }: { school: PlatformSchoolDetail }) {
  const { t } = useTranslation();
  const { formatDate, formatNumber } = useFormatters();
  const sub = school.subscription;

  return (
    <Card as="section" aria-labelledby="platform-subscription-title">
      <Card.Header>
        <h2 id="platform-subscription-title">{t("platform.school.subscription.title")}</h2>
      </Card.Header>
      <Card.Body>
        {!sub ? (
          <p className="platform-muted">{t("platform.schools.noSubscription")}</p>
        ) : (
          <dl className="platform-dl">
            <dt>{t("platform.school.subscription.plan")}</dt>
            <dd>
              {sub.planName} <code>{sub.planCode}</code>
            </dd>
            <dt>{t("platform.school.subscription.status")}</dt>
            <dd>{t(`platform.subscriptionStatus.${sub.status}`, { defaultValue: sub.status })}</dd>
            <dt>{t("platform.school.subscription.seats")}</dt>
            <dd>
              {t("platform.school.subscription.seatsValue", {
                used: formatNumber(school.students),
                cap: formatNumber(sub.studentCap),
              })}
            </dd>
            <dt>{t("platform.school.subscription.periodEnd")}</dt>
            <dd>{formatDate(new Date(sub.currentPeriodEnd), { dateStyle: "medium" })}</dd>
            {sub.trialExpiresAt ? (
              <>
                <dt>{t("platform.school.subscription.trialEnds")}</dt>
                <dd>{formatDate(new Date(sub.trialExpiresAt), { dateStyle: "medium" })}</dd>
              </>
            ) : null}
          </dl>
        )}
      </Card.Body>
    </Card>
  );
}

/** Roles that are issued a member code (000140), always listed first with their code prefix. */
const CODED_ROLES = [
  { role: "STUDENT", prefix: "STU" },
  { role: "INSTRUCTOR", prefix: "TCH" },
  { role: "PARENT", prefix: "PAR" },
] as const;

function PeopleCard({ school }: { school: PlatformSchoolDetail }) {
  const { t } = useTranslation();
  const { formatNumber } = useFormatters();
  const coded = new Set<string>(CODED_ROLES.map(({ role }) => role));
  const roles = Object.entries(school.roleCounts)
    .filter(([role]) => !coded.has(role))
    .sort(([, a], [, b]) => b - a);

  return (
    <Card as="section" aria-labelledby="platform-people-title">
      <Card.Header>
        <h2 id="platform-people-title">{t("platform.school.people.title")}</h2>
      </Card.Header>
      <Card.Body>
        <p>{t("platform.school.people.activeUsers", { count: school.activeUsers })}</p>
        <ul className="platform-breakdown">
          {CODED_ROLES.map(({ role, prefix }) => (
            <li key={role}>
              <span className="platform-cell-stack">
                <span>{t(`platform.roles.${role}`)}</span>
                <span className="platform-muted">
                  {t("platform.school.people.codePrefix", {
                    prefix: `${prefix}-${school.schoolNumber}`,
                  })}
                </span>
              </span>
              {/* eslint-disable-next-line security/detect-object-injection -- `role` comes from the fixed CODED_ROLES list, not user input */}
              <strong>{formatNumber(school.roleCounts[role] ?? 0)}</strong>
            </li>
          ))}
          {roles.map(([role, count]) => (
            <li key={role}>
              <span>{t(`platform.roles.${role}`, { defaultValue: role })}</span>
              <strong>{formatNumber(count)}</strong>
            </li>
          ))}
        </ul>
      </Card.Body>
    </Card>
  );
}

function FeatureFlagsCard({ school }: { school: PlatformSchoolDetail }) {
  const { t } = useTranslation();
  const { show } = useToast();
  const setFlag = useSetFeatureFlag(school.id);

  const options: SelectOption<FlagChoice>[] = [
    { value: "default", label: t("platform.school.flags.useDefault") },
    { value: "on", label: t("platform.school.flags.forceOn") },
    { value: "off", label: t("platform.school.flags.forceOff") },
  ];

  function choiceOf(flag: PlatformFeatureFlagState): FlagChoice {
    if (flag.override === null) return "default";
    return flag.override ? "on" : "off";
  }

  function handleChange(flag: PlatformFeatureFlagState, choice: FlagChoice) {
    const enabled = choice === "default" ? null : choice === "on";
    setFlag.mutate(
      { flag: flag.name, enabled },
      {
        onSuccess: () => show({ variant: "success", title: t("platform.school.flags.saved") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("platform.school.flags.error"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Card as="section" aria-labelledby="platform-flags-title">
      <Card.Header>
        <h2 id="platform-flags-title">{t("platform.school.flags.title")}</h2>
      </Card.Header>
      <Card.Body>
        <p className="platform-muted">{t("platform.school.flags.description")}</p>
        <ul className="platform-flag-list">
          {school.featureFlags.map((flag) => (
            <li key={flag.name} className="platform-flag">
              <div className="platform-cell-stack">
                <code>{flag.name}</code>
                <span className="platform-muted">{flag.description}</span>
                <span className="platform-muted">
                  {t("platform.school.flags.defaultIs", {
                    value: flag.defaultValue ? t("platform.common.on") : t("platform.common.off"),
                  })}
                </span>
              </div>
              <Select
                label={t("platform.school.flags.valueLabel", { flag: flag.name })}
                options={options}
                value={choiceOf(flag)}
                disabled={setFlag.isPending}
                onChange={(choice) => handleChange(flag, choice)}
              />
            </li>
          ))}
        </ul>
      </Card.Body>
    </Card>
  );
}

function ChangeStatusDialog({
  school,
  target,
  onClose,
}: {
  school: PlatformSchoolDetail;
  target: PlatformSchoolStatus | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const change = useChangeSchoolStatus(school.id);
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const open = target !== null;
  // Archiving cannot be undone, so it asks for the school's name, as destructive console actions do.
  const needsNameConfirm = target === "archived";
  const reasonValid = reason.trim().length >= 3;
  const canSubmit = reasonValid && (!needsNameConfirm || confirmName.trim() === school.name);

  function close() {
    setReason("");
    setConfirmName("");
    onClose();
  }

  function submit() {
    if (!target || !canSubmit) return;
    change.mutate(
      { status: target, reason: reason.trim() },
      {
        onSuccess: (result) => {
          show({
            variant: result.aiBillingSynced ? "success" : "error",
            title: t("platform.school.lifecycle.success", {
              status: t(`platform.status.${target}`),
            }),
            description: result.aiBillingSynced
              ? result.aiSubscriptionsAffected !== null
                ? t("platform.school.lifecycle.aiAffected", {
                    count: result.aiSubscriptionsAffected,
                  })
                : undefined
              : t("platform.school.lifecycle.aiSyncFailed"),
          });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platform.school.lifecycle.error"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        target
          ? t(`platform.school.lifecycle.actions.${target}`)
          : t("platform.school.lifecycle.title")
      }
      description={school.name}
    >
      <Modal.Body>
        {target ? <p>{t(`platform.school.lifecycle.consequence.${target}`)}</p> : null}
        <Input
          label={t("platform.school.lifecycle.reasonLabel")}
          helperText={t("platform.school.lifecycle.reasonHelp")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
        {needsNameConfirm ? (
          <Input
            label={t("platform.school.lifecycle.confirmNameLabel", { name: school.name })}
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            autoComplete="off"
          />
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!canSubmit}
          loading={change.isPending}
          onClick={submit}
        >
          {t("platform.school.lifecycle.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
