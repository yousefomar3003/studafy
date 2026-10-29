import { ApiError } from "@studafy/api-client";
import { Button, Card, DataGrid, Input, Select, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSearchParamFlag } from "../../../lib/use-search-param-flag";
import { ROLE_LABEL_KEYS } from "../users/schema";

import { useInviteStaff, useResendStaffInvitation, useRevokeStaffInvitation } from "./mutations";
import { STAFF_ROLES, useStaffInvitationsQuery } from "./queries";

import "../users/users.css";
import "./staff.css";

import type { StaffInvitation, StaffRole } from "./queries";
import type { DataGridColumn, SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const emailSchema = z.string().trim().min(1).email();

/** Maps an invitation's lifecycle onto the user-status pill colours `users.css` already defines. */
const PILL_STATUS: Record<StaffInvitation["status"], string> = {
  pending: "invited",
  consumed: "active",
  expired: "suspended",
  revoked: "archived",
};

/**
 * Principal and finance accounts (`/portal/accounts`, the sidebar item under "Admin"), gated by
 * `organization:manageSettings` like `/portal/admin`. The admin enters an email and a role; the API emails an
 * invitation link, and the invitee activates the account by signing in with Google or Microsoft
 * (Outlook) on `/invite/:token` — the account only exists once they have.
 */
export default function StaffAccountsPage() {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const { data, isPending, isError } = useStaffInvitationsQuery();
  const invite = useInviteStaff();
  const resend = useResendStaffInvitation();
  const revoke = useRevokeStaffInvitation();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>(STAFF_ROLES[0]);
  const [emailError, setEmailError] = useState<string | undefined>();

  // `?invite=1` (the global search's "Invite staff") lands on the invite form ready to type into.
  // The form is inline rather than a modal, so the parameter is dropped once it has been focused.
  const emailRef = useRef<HTMLInputElement>(null);
  const [inviteParam, clearInviteParam] = useSearchParamFlag("invite");
  useEffect(() => {
    if (inviteParam !== "1") return;
    emailRef.current?.scrollIntoView?.({ block: "center" });
    emailRef.current?.focus();
    clearInviteParam();
  }, [inviteParam, clearInviteParam]);

  const roleLabel = (value: string) => t(ROLE_LABEL_KEYS[value as StaffRole] ?? value);
  const roleOptions: SelectOption<StaffRole>[] = STAFF_ROLES.map((value) => ({
    value,
    label: roleLabel(value),
  }));

  function apiErrorDescription(error: unknown) {
    return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(t("adminPeople.validation.emailInvalid"));
      return;
    }
    invite.mutate(
      { email: parsed.data, role },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: t("adminPeople.staff.invite.sentToast", { email: parsed.data }),
          });
          setEmail("");
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("adminPeople.staff.invite.error"),
            description: apiErrorDescription(error),
          }),
      },
    );
  }

  function handleResend(invitation: StaffInvitation) {
    resend.mutate(invitation.id, {
      onSuccess: () =>
        show({
          variant: "success",
          title: t("adminPeople.staff.list.resentToast", { email: invitation.email }),
        }),
      onError: (error) =>
        show({
          variant: "error",
          title: t("adminPeople.staff.list.actionError"),
          description: apiErrorDescription(error),
        }),
    });
  }

  function handleRevoke(invitation: StaffInvitation) {
    revoke.mutate(invitation.id, {
      onSuccess: () =>
        show({
          variant: "success",
          title: t("adminPeople.staff.list.revokedToast", { email: invitation.email }),
        }),
      onError: (error) =>
        show({
          variant: "error",
          title: t("adminPeople.staff.list.actionError"),
          description: apiErrorDescription(error),
        }),
    });
  }

  const columns: DataGridColumn<StaffInvitation>[] = [
    {
      id: "email",
      header: t("adminPeople.staff.list.columns.email"),
      renderCell: (invitation) => invitation.email,
    },
    {
      id: "role",
      header: t("adminPeople.staff.list.columns.role"),
      renderCell: (invitation) => roleLabel(invitation.role),
    },
    {
      id: "status",
      header: t("adminPeople.staff.list.columns.status"),
      renderCell: (invitation) => (
        <span className="users-list__status-pill" data-status={PILL_STATUS[invitation.status]}>
          {t(`adminPeople.staff.status.${invitation.status}`)}
        </span>
      ),
    },
    {
      id: "sent",
      header: t("adminPeople.staff.list.columns.sent"),
      renderCell: (invitation) =>
        formatDate(new Date(invitation.created_at), { dateStyle: "medium" }),
    },
    {
      id: "actions",
      header: t("adminPeople.staff.list.columns.actions"),
      renderCell: (invitation) =>
        invitation.status === "pending" || invitation.status === "expired" ? (
          <div className="users-list__actions">
            <Button
              variant="tertiary"
              disabled={resend.isPending}
              onClick={() => handleResend(invitation)}
            >
              {t("adminPeople.staff.list.resend")}
            </Button>
            {invitation.status === "pending" ? (
              <Button
                variant="tertiary"
                disabled={revoke.isPending}
                onClick={() => handleRevoke(invitation)}
              >
                {t("adminPeople.staff.list.revoke")}
              </Button>
            ) : null}
          </div>
        ) : (
          <span>—</span>
        ),
    },
  ];

  return (
    <>
      <div className="users-list__header">
        <div>
          <h1>{t("adminPeople.staff.title")}</h1>
          <p>{t("adminPeople.staff.description")}</p>
        </div>
      </div>

      <div className="staff-invite">
        <Card as="section" aria-labelledby="staff-invite-title">
          <Card.Header>
            <h2 id="staff-invite-title">{t("adminPeople.staff.invite.title")}</h2>
          </Card.Header>
          <Card.Body>
            <p>{t("adminPeople.staff.invite.signInNote")}</p>
            <form
              className="staff-invite__form"
              onSubmit={handleSubmit}
              noValidate
              aria-label={t("adminPeople.staff.invite.title")}
            >
              <Input
                ref={emailRef}
                label={t("adminPeople.users.form.email")}
                type="email"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailError(undefined);
                }}
                error={emailError}
                required
              />
              <Select
                label={t("adminPeople.users.form.role")}
                options={roleOptions}
                value={role}
                onChange={(value) => setRole(value)}
                required
              />
              <Button type="submit" loading={invite.isPending}>
                {t("adminPeople.staff.invite.submit")}
              </Button>
            </form>
          </Card.Body>
        </Card>
      </div>

      <DataGrid
        caption={t("adminPeople.staff.list.caption")}
        columns={columns}
        rows={data ?? []}
        getRowId={(invitation) => invitation.id}
        getRowLabel={(invitation) => invitation.email}
        loading={isPending}
        empty={isError ? t("adminPeople.staff.list.loadError") : t("adminPeople.staff.list.empty")}
      />
    </>
  );
}
