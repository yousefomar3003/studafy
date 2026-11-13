import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Modal, useToast } from "@studafy/ui";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useFormatters, useTranslation } from "../../lib/i18n";

import { PlatformPageHeader, SchoolStatusPill } from "./PlatformNav";
import { availableActions, useSupportAction, useSupportUserQuery } from "./user-support";

import "./platform.css";

import type { PlatformSupportUser, SupportActionName } from "./user-support";

/**
 * One account's support panel (`/portal/platform/schools/:schoolId/users/:userId`): who the account
 * is, how it signs in, and the support actions that apply to it. Every action asks for a reason,
 * which lands in the school's audit log and the operator's. There is no "sign in as this user":
 * Studafy staff never act as a school member.
 */
export default function UserSupportPage() {
  const { schoolId = "", userId = "" } = useParams();
  const { t } = useTranslation();
  const { data: user, isPending, isError } = useSupportUserQuery(schoolId, userId);
  const [action, setAction] = useState<SupportActionName | null>(null);

  if (isPending) return <p role="status">{t("site.common.loading")}</p>;
  if (isError || !user) {
    return (
      <>
        <p role="alert">{t("platform.support.loadError")}</p>
        <Link to="/portal/platform/users">{t("platform.support.back")}</Link>
      </>
    );
  }

  const actions = availableActions(user);
  const title = user.displayName ?? user.email ?? user.memberCodes[0] ?? user.userId;

  return (
    <>
      <PlatformPageHeader
        title={title}
        description={user.school.name}
        actions={<SchoolStatusPill status={user.school.status} />}
      />
      <p>
        <Link to="/portal/platform/users">{t("platform.support.back")}</Link>
        {" · "}
        <Link to={`/portal/platform/schools/${user.school.id}`}>
          {t("platform.support.openSchool")}
        </Link>
      </p>

      <div className="platform-grid">
        <AccountCard user={user} />
        <SignInCard user={user} />
        <LinksCard user={user} />
      </div>

      <Card as="section" aria-labelledby="platform-support-actions-title">
        <Card.Header>
          <h2 id="platform-support-actions-title">{t("platform.support.actions.title")}</h2>
        </Card.Header>
        <Card.Body>
          {!user.actionable ? (
            <p className="platform-muted">{t("platform.support.actions.protected")}</p>
          ) : actions.length === 0 ? (
            <p className="platform-muted">{t("platform.support.actions.none")}</p>
          ) : (
            <div className="platform-actions">
              {actions.map((name) => (
                <Button
                  key={name}
                  variant={name === "deactivate" ? "secondary" : "primary"}
                  onClick={() => setAction(name)}
                >
                  {t(`platform.support.actions.${name}.label`)}
                </Button>
              ))}
            </div>
          )}
          <p className="platform-muted">{t("platform.support.actions.noImpersonation")}</p>
        </Card.Body>
      </Card>

      <ActionDialog
        schoolId={schoolId}
        userId={userId}
        name={title}
        action={action}
        onClose={() => setAction(null)}
      />
    </>
  );
}

function AccountCard({ user }: { user: PlatformSupportUser }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const date = (value: string | null) =>
    value
      ? formatDate(new Date(value), { dateStyle: "medium", timeStyle: "short" })
      : t("platform.common.never");

  return (
    <Card as="section" aria-labelledby="platform-support-account-title">
      <Card.Header>
        <h2 id="platform-support-account-title">{t("platform.support.account.title")}</h2>
      </Card.Header>
      <Card.Body>
        <dl className="platform-dl">
          <dt>{t("platform.support.account.email")}</dt>
          <dd>{user.email ?? "—"}</dd>
          <dt>{t("platform.support.account.memberCodes")}</dt>
          <dd>{user.memberCodes.join(", ") || "—"}</dd>
          <dt>{t("platform.support.account.roles")}</dt>
          <dd>
            {user.roles
              .map((role) => t(`platform.roles.${role}`, { defaultValue: role }))
              .join(", ") || "—"}
          </dd>
          <dt>{t("platform.support.account.status")}</dt>
          <dd>{t(`platform.userStatus.${user.status}`, { defaultValue: user.status })}</dd>
          <dt>{t("platform.support.account.activated")}</dt>
          <dd>
            {user.activated ? t("platform.common.yes") : t("platform.support.account.notYet")}
          </dd>
          <dt>{t("platform.support.account.created")}</dt>
          <dd>{date(user.createdAt)}</dd>
          <dt>{t("platform.support.account.lastLogin")}</dt>
          <dd>{date(user.lastLoginAt)}</dd>
        </dl>
      </Card.Body>
    </Card>
  );
}

function SignInCard({ user }: { user: PlatformSupportUser }) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const methods = [
    ...user.signIn.providers.map((provider) =>
      t(`platform.support.signIn.provider.${provider}`, { defaultValue: provider }),
    ),
    ...(user.signIn.memberPassword ? [t("platform.support.signIn.memberPassword")] : []),
  ];

  return (
    <Card as="section" aria-labelledby="platform-support-signin-title">
      <Card.Header>
        <h2 id="platform-support-signin-title">{t("platform.support.signIn.title")}</h2>
      </Card.Header>
      <Card.Body>
        <dl className="platform-dl">
          <dt>{t("platform.support.signIn.methods")}</dt>
          <dd>{methods.join(", ") || t("platform.support.signIn.noMethod")}</dd>
          <dt>{t("platform.support.signIn.locked")}</dt>
          <dd>
            {user.signIn.locked && user.signIn.lockedUntil
              ? t("platform.support.signIn.lockedUntil", {
                  time: formatDate(new Date(user.signIn.lockedUntil), { timeStyle: "short" }),
                })
              : user.signIn.failedAttempts > 0
                ? t("platform.support.signIn.failedAttempts", {
                    count: user.signIn.failedAttempts,
                  })
                : t("platform.support.signIn.notLocked")}
          </dd>
          <dt>{t("platform.support.signIn.sessions")}</dt>
          <dd>{user.activeSessions}</dd>
          <dt>{t("platform.support.signIn.invitation")}</dt>
          <dd>
            {user.invitation
              ? t(`platform.support.signIn.invitationStatus.${user.invitation.status}`, {
                  date: formatDate(new Date(user.invitation.expiresAt), { dateStyle: "medium" }),
                })
              : "—"}
          </dd>
        </dl>
      </Card.Body>
    </Card>
  );
}

function LinksCard({ user }: { user: PlatformSupportUser }) {
  const { t } = useTranslation();
  const people = user.children.length > 0 ? user.children : user.parents;
  const heading =
    user.children.length > 0
      ? t("platform.support.links.children")
      : t("platform.support.links.parents");

  return (
    <Card as="section" aria-labelledby="platform-support-links-title">
      <Card.Header>
        <h2 id="platform-support-links-title">{heading}</h2>
      </Card.Header>
      <Card.Body>
        {people.length === 0 ? (
          <p className="platform-muted">{t("platform.support.links.none")}</p>
        ) : (
          <ul>
            {people.map((person, index) => (
              <li key={`${person.name ?? ""}-${index}`}>
                {person.name ?? "—"}
                {" · "}
                {t(`platform.support.links.relationship.${person.relationship}`, {
                  defaultValue: person.relationship,
                })}
              </li>
            ))}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}

function ActionDialog({
  schoolId,
  userId,
  name,
  action,
  onClose,
}: {
  schoolId: string;
  userId: string;
  name: string;
  action: SupportActionName | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const run = useSupportAction(schoolId, userId);
  const [reason, setReason] = useState("");
  const reasonValid = reason.trim().length >= 3;

  function close() {
    setReason("");
    onClose();
  }

  function submit() {
    if (!action || !reasonValid) return;
    run.mutate(
      { action, reason: reason.trim() },
      {
        onSuccess: () => {
          show({ variant: "success", title: t(`platform.support.actions.${action}.success`) });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("platform.support.actions.error"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={action !== null}
      onClose={close}
      title={action ? t(`platform.support.actions.${action}.label`) : ""}
      description={name}
    >
      <Modal.Body>
        {action ? <p>{t(`platform.support.actions.${action}.consequence`)}</p> : null}
        <Input
          label={t("platform.support.actions.reasonLabel")}
          helperText={t("platform.support.actions.reasonHelp")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("platform.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!reasonValid}
          loading={run.isPending}
          onClick={submit}
        >
          {t("platform.support.actions.confirm")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
