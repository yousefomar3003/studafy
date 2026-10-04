import { ApiError } from "@studafy/api-client";
import { Button, DataGrid, FilterBar, Select, useToast } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useFormatters, useTranslation } from "../../../lib/i18n";

import { useResendInvitation } from "./mutations";
import {
  EMPTY_INVITATIONS_FILTERS,
  fetchInvitationsPage,
  invitationsListQueryKey,
} from "./queries";
import { INVITATION_ROLES, INVITATION_STATUS_LABEL_KEYS, ROLE_LABEL_KEYS } from "./schema";

import type { InviteLinkDetails } from "./InviteLinkDialog";
import type { InvitationsFilters, InvitationWithStatus } from "./queries";
import type { InvitationRole } from "./schema";
import type { Role } from "@studafy/constants";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

/** Matches `Date#toLocaleString()`'s default fields, now formatted in the active locale. */
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};

/** Resend/revoke only make sense for invitations the backend hasn't already terminated — its
 * `revoke`/`regenerate` routes 404 once `revoked_at`/`consumed_at` is set, which covers "consumed"
 * and "revoked" but not "expired" (expiry is derived, not a stored flag — see the API's migration
 * comment), so an expired invitation is still eligible for both actions. */
function canManage(status: InvitationWithStatus["status"]): boolean {
  return status === "pending" || status === "expired";
}

export interface InvitationsBoardProps {
  onCreate: () => void;
  onRevoke: (invitation: InvitationWithStatus) => void;
  onResent: (details: InviteLinkDetails) => void;
}

export function InvitationsBoard({ onCreate, onRevoke, onResent }: InvitationsBoardProps) {
  const { t } = useTranslation();
  const { formatDate } = useFormatters();
  const { show } = useToast();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [role, setRole] = useState<InvitationsFilters["role"]>("");
  const [status, setStatus] = useState<InvitationsFilters["status"]>("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const filters: InvitationsFilters = useMemo(
    () => ({ ...EMPTY_INVITATIONS_FILTERS, search: debouncedSearch, role, status }),
    [debouncedSearch, role, status],
  );

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  useEffect(() => {
    setCursor(undefined);
    setCursorHistory([]);
  }, [filters.search, filters.role, filters.status]);

  const { data, isPending, isError } = useQuery({
    queryKey: invitationsListQueryKey(filters, cursor),
    queryFn: () => fetchInvitationsPage(filters, cursor),
    placeholderData: keepPreviousData,
  });

  const roleOptions: SelectOption<InvitationRole | "">[] = [
    { value: "", label: t("adminPeople.invitations.board.allRoles") },
    // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `INVITATION_ROLES` array, not user input
    ...INVITATION_ROLES.map((role) => ({ value: role, label: t(ROLE_LABEL_KEYS[role]) })),
  ];

  const statusOptions: SelectOption<InvitationsFilters["status"]>[] = [
    { value: "", label: t("adminPeople.invitations.board.allStatuses") },
    ...(
      Object.entries(INVITATION_STATUS_LABEL_KEYS) as [InvitationsFilters["status"], string][]
    ).map(([value, key]) => ({ value, label: t(key) })),
  ];

  const resendInvitation = useResendInvitation();
  const [resendingId, setResendingId] = useState<string | null>(null);

  function handleResend(invitation: InvitationWithStatus) {
    setResendingId(invitation.id);
    resendInvitation.mutate(invitation.id, {
      onSuccess: (result) => {
        onResent({ email: result.invitation.email, token: result.token });
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminPeople.invitations.board.resendError"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
      onSettled: () => setResendingId(null),
    });
  }

  const columns: DataGridColumn<InvitationWithStatus>[] = [
    {
      id: "email",
      header: t("adminPeople.invitations.board.columns.email"),
      renderCell: (invitation) => invitation.email,
    },
    {
      id: "role",
      header: t("adminPeople.invitations.board.columns.role"),
      renderCell: (invitation) => {
        const key = ROLE_LABEL_KEYS[invitation.role as Role];
        return key ? t(key) : invitation.role;
      },
    },
    {
      id: "status",
      header: t("adminPeople.invitations.board.columns.status"),
      renderCell: (invitation) => (
        <span className="invitations-status-pill" data-status={invitation.status}>
          {t(INVITATION_STATUS_LABEL_KEYS[invitation.status])}
        </span>
      ),
    },
    {
      id: "expires_at",
      header: t("adminPeople.invitations.board.columns.expires"),
      renderCell: (invitation) => formatDate(new Date(invitation.expires_at), DATE_TIME_OPTIONS),
    },
    {
      id: "created_at",
      header: t("adminPeople.invitations.board.columns.sent"),
      renderCell: (invitation) => formatDate(new Date(invitation.created_at), DATE_TIME_OPTIONS),
    },
    {
      id: "actions",
      header: t("adminPeople.invitations.board.columns.actions"),
      renderCell: (invitation) =>
        canManage(invitation.status) ? (
          <div className="invitations-board__actions">
            <Button
              variant="tertiary"
              loading={resendInvitation.isPending && resendingId === invitation.id}
              onClick={() => handleResend(invitation)}
            >
              {t("adminPeople.invitations.board.resend")}
            </Button>
            <Button variant="tertiary" onClick={() => onRevoke(invitation)}>
              {t("adminPeople.invitations.board.revoke")}
            </Button>
          </div>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <>
      <div className="invitations-board__header">
        <p>{t("adminPeople.invitations.board.description")}</p>
        <Button onClick={onCreate}>{t("adminPeople.invitations.board.newInvitation")}</Button>
      </div>

      <div className="invitations-board__toolbar">
        <FilterBar
          searchLabel={t("adminPeople.invitations.board.searchLabel")}
          searchPlaceholder={t("adminPeople.invitations.board.searchPlaceholder")}
          search={searchInput}
          onSearchChange={setSearchInput}
        />
        <Select
          label={t("adminPeople.invitations.board.roleFilter")}
          options={roleOptions}
          value={role}
          onChange={(value) => setRole(value)}
        />
        <Select
          label={t("adminPeople.invitations.board.statusFilter")}
          options={statusOptions}
          value={status}
          onChange={(value) => setStatus(value)}
        />
      </div>

      <DataGrid
        caption={t("adminPeople.invitations.board.caption")}
        columns={columns}
        rows={data?.invitations ?? []}
        getRowId={(invitation) => invitation.id}
        getRowLabel={(invitation) => invitation.email}
        loading={isPending}
        empty={
          isError
            ? t("adminPeople.invitations.board.loadError")
            : t("adminPeople.invitations.board.empty")
        }
      />

      <div className="invitations-board__pagination">
        <Button
          variant="secondary"
          disabled={cursorHistory.length === 0}
          onClick={() => {
            const next = [...cursorHistory];
            const previous = next.pop();
            setCursorHistory(next);
            setCursor(previous);
          }}
        >
          {t("adminPeople.common.previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={!data?.next_cursor}
          onClick={() => {
            const nextCursor = data?.next_cursor;
            if (!nextCursor) return;
            setCursorHistory([...cursorHistory, cursor]);
            setCursor(nextCursor);
          }}
        >
          {t("adminPeople.common.next")}
        </Button>
      </div>
    </>
  );
}
