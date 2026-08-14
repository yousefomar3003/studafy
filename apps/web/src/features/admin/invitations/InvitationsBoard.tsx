import { ApiError } from "@studafy/api-client";
import { Button, DataGrid, FilterBar, Select, useToast } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useResendInvitation } from "./mutations";
import {
  EMPTY_INVITATIONS_FILTERS,
  fetchInvitationsPage,
  invitationsListQueryKey,
} from "./queries";
import { INVITATION_ROLES, INVITATION_STATUS_LABELS, ROLE_LABELS } from "./schema";

import type { InviteLinkDetails } from "./InviteLinkDialog";
import type { InvitationsFilters, InvitationWithStatus } from "./queries";
import type { InvitationRole } from "./schema";
import type { Role } from "@studafy/constants";
import type { DataGridColumn, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

const ROLE_OPTIONS: SelectOption<InvitationRole | "">[] = [
  { value: "", label: "All roles" },
  // eslint-disable-next-line security/detect-object-injection -- `role` comes from iterating this module's own fixed `INVITATION_ROLES` array, not user input
  ...INVITATION_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] })),
];

const STATUS_OPTIONS: SelectOption<InvitationsFilters["status"]>[] = [
  { value: "", label: "All statuses" },
  ...(Object.entries(INVITATION_STATUS_LABELS) as [InvitationsFilters["status"], string][]).map(
    ([value, label]) => ({ value, label }),
  ),
];

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
          title: "Couldn't resend invitation",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
      onSettled: () => setResendingId(null),
    });
  }

  const columns: DataGridColumn<InvitationWithStatus>[] = [
    { id: "email", header: "Email", renderCell: (invitation) => invitation.email },
    {
      id: "role",
      header: "Role",
      renderCell: (invitation) => ROLE_LABELS[invitation.role as Role] ?? invitation.role,
    },
    {
      id: "status",
      header: "Status",
      renderCell: (invitation) => (
        <span className="invitations-status-pill" data-status={invitation.status}>
          {INVITATION_STATUS_LABELS[invitation.status]}
        </span>
      ),
    },
    {
      id: "expires_at",
      header: "Expires",
      renderCell: (invitation) => new Date(invitation.expires_at).toLocaleString(),
    },
    {
      id: "created_at",
      header: "Sent",
      renderCell: (invitation) => new Date(invitation.created_at).toLocaleString(),
    },
    {
      id: "actions",
      header: "Actions",
      renderCell: (invitation) =>
        canManage(invitation.status) ? (
          <div className="invitations-board__actions">
            <Button
              variant="tertiary"
              loading={resendInvitation.isPending && resendingId === invitation.id}
              onClick={() => handleResend(invitation)}
            >
              Resend
            </Button>
            <Button variant="tertiary" onClick={() => onRevoke(invitation)}>
              Revoke
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
        <p>Track and manage invite links: resend, revoke, or copy a link directly.</p>
        <Button onClick={onCreate}>New invitation</Button>
      </div>

      <div className="invitations-board__toolbar">
        <FilterBar
          searchLabel="Search"
          searchPlaceholder="Search by email"
          search={searchInput}
          onSearchChange={setSearchInput}
        />
        <Select
          label="Role"
          options={ROLE_OPTIONS}
          value={role}
          onChange={(value) => setRole(value)}
        />
        <Select
          label="Status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(value) => setStatus(value)}
        />
      </div>

      <DataGrid
        caption="Invitations"
        columns={columns}
        rows={data?.invitations ?? []}
        getRowId={(invitation) => invitation.id}
        getRowLabel={(invitation) => invitation.email}
        loading={isPending}
        empty={isError ? "Unable to load invitations." : "No invitations match these filters."}
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
          Previous
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
          Next
        </Button>
      </div>
    </>
  );
}
