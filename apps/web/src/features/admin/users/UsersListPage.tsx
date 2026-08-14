import { Button, DataGrid, FilterBar, Select } from "@studafy/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { CreateUserModal } from "./CreateUserModal";
import { DeactivateUserDialog } from "./DeactivateUserDialog";
import { EditUserModal } from "./EditUserModal";
import { fetchUsersPage, usersListQueryKey } from "./queries";
import { ROLE_LABELS, STATUS_LABELS } from "./schema";
import { UserSessionsPanel } from "./UserSessionsPanel";

import "./users.css";

import type { UsersFilters, UserWithRoles } from "./queries";
import type { Role } from "@studafy/constants";
import type { DataGridColumn, DateRangeValue, SelectOption } from "@studafy/ui";

const SEARCH_DEBOUNCE_MS = 300;

const ROLE_OPTIONS: SelectOption<Role | "">[] = [
  { value: "", label: "All roles" },
  ...(Object.entries(ROLE_LABELS) as [Role, string][]).map(([value, label]) => ({ value, label })),
];

const STATUS_OPTIONS: SelectOption<UsersFilters["status"]>[] = [
  { value: "", label: "All statuses" },
  ...(Object.entries(STATUS_LABELS) as [UsersFilters["status"], string][]).map(
    ([value, label]) => ({ value, label }),
  ),
];

function statusToneLabel(status: UserWithRoles["status"]): string {
  return STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status;
}

/**
 * User management (`/portal/admin/users`), gated by `organization:manageSettings` like the rest of
 * `/portal/admin` — user CRUD, role assignment, and deactivation are org-admin-only surfaces.
 *
 * Pagination and filtering go through TanStack Query rather than `@studafy/ui`'s own
 * `useCursorPagination` hook: every mutation below (create/edit/role/deactivate) needs to write
 * optimistic patches into the list cache and roll them back on error, which only makes sense against
 * one cache — and every other data view in this app already uses TanStack Query's. Running both
 * would mean two competing sources of truth for "what page am I on" for no benefit.
 */
export default function UsersListPage() {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [role, setRole] = useState<UsersFilters["role"]>("");
  const [status, setStatus] = useState<UsersFilters["status"]>("");
  const [dateRange, setDateRange] = useState<DateRangeValue>({});

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const filters: UsersFilters = useMemo(
    () => ({ search: debouncedSearch, role, status, dateRange }),
    [debouncedSearch, role, status, dateRange],
  );

  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = useState<(string | undefined)[]>([]);

  // A new filter set always starts back at page one — the cursor from the previous filters names a
  // position in a different result set and would page through the wrong rows.
  useEffect(() => {
    setCursor(undefined);
    setCursorHistory([]);
  }, [filters.search, filters.role, filters.status, filters.dateRange.from, filters.dateRange.to]);

  const { data, isPending, isError } = useQuery({
    queryKey: usersListQueryKey(filters, cursor),
    queryFn: () => fetchUsersPage(filters, cursor),
    placeholderData: keepPreviousData,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserWithRoles | null>(null);
  const [deactivatingUser, setDeactivatingUser] = useState<UserWithRoles | null>(null);
  const [sessionsUser, setSessionsUser] = useState<UserWithRoles | null>(null);

  const columns: DataGridColumn<UserWithRoles>[] = [
    {
      id: "name",
      header: "Name",
      renderCell: (user) => user.display_name ?? "—",
    },
    {
      id: "email",
      header: "Email",
      renderCell: (user) => user.email,
    },
    {
      id: "role",
      header: "Role",
      renderCell: (user) => user.roles.map((r) => ROLE_LABELS[r as Role] ?? r).join(", ") || "—",
    },
    {
      id: "status",
      header: "Status",
      renderCell: (user) => (
        <span className="users-list__status-pill" data-status={user.status}>
          {statusToneLabel(user.status)}
        </span>
      ),
    },
    {
      id: "last_login",
      header: "Last active",
      renderCell: (user) =>
        user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "Never",
    },
    {
      id: "actions",
      header: "Actions",
      renderCell: (user) => (
        <div className="users-list__actions">
          <Button variant="tertiary" onClick={() => setEditingUser(user)}>
            Edit
          </Button>
          <Button variant="tertiary" onClick={() => setSessionsUser(user)}>
            Sessions
          </Button>
          {user.status !== "suspended" && user.status !== "archived" ? (
            <Button variant="tertiary" onClick={() => setDeactivatingUser(user)}>
              Deactivate
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="users-list__header">
        <div>
          <h1>Users</h1>
          <p>Invite, edit, and manage access for everyone in your school.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New user</Button>
      </div>

      <div className="users-list__toolbar">
        <FilterBar
          searchLabel="Search"
          searchPlaceholder="Search by name or email"
          search={searchInput}
          onSearchChange={setSearchInput}
          dateRange={dateRange}
          dateRangeLabel="Created between"
          onDateRangeChange={setDateRange}
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
        caption="School users"
        columns={columns}
        rows={data?.users ?? []}
        getRowId={(user) => user.id}
        getRowLabel={(user) => user.display_name ?? user.email}
        loading={isPending}
        empty={isError ? "Unable to load users." : "No users match these filters."}
      />

      <div className="users-list__pagination">
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

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} />

      <DeactivateUserDialog user={deactivatingUser} onClose={() => setDeactivatingUser(null)} />

      <UserSessionsPanel user={sessionsUser} onClose={() => setSessionsUser(null)} />
    </>
  );
}
