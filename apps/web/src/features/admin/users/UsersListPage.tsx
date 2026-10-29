import { PERMISSIONS } from "@studafy/constants";
import { Button, DataGrid, FilterBar, Select } from "@studafy/ui";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { ImportCsvButton } from "../../../components/ImportCsvButton";
import { api } from "../../../lib/api";
import { usePermissions } from "../../../lib/auth";
import { useFormatters, useTranslation } from "../../../lib/i18n";
import { useSearchParamFlag } from "../../../lib/use-search-param-flag";

import { CreateUserModal } from "./CreateUserModal";
import { DeactivateUserDialog } from "./DeactivateUserDialog";
import { EditUserModal } from "./EditUserModal";
import { fetchUsersPage, USERS_LIST_KEY, usersListQueryKey } from "./queries";
import { ASSIGNABLE_ROLES, createUserSchema, ROLE_LABEL_KEYS, STATUS_LABEL_KEYS } from "./schema";
import { UserSessionsPanel } from "./UserSessionsPanel";

import "./users.css";

import type { UsersFilters, UserWithRoles } from "./queries";
import type { CreateUserValues } from "./schema";
import type { ImportSpec } from "../../../lib/data-transfer";
import type { Role } from "@studafy/constants";
import type { DataGridColumn, DateRangeValue, SelectOption } from "@studafy/ui";

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
  // Prefills from `?q=` -- the deep-link target the global search palette (`features/search`)
  // sends a matched user to, since there is no per-user detail route to link straight to a record
  // (see `result-groups.ts`'s doc comment on why). Read once on mount, not kept in sync afterward:
  // this is a starting point for the local search box below, not a URL-driven filter.
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  const { formatDate } = useFormatters();
  const [searchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get("q") ?? "");
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

  // `?create=1` opens "New user" on arrival, and `?create=PARENT` (any assignable role) opens it on
  // that role — the global search's "Add a parent" / "Add a teacher". Closing drops the parameter.
  const [createParam, clearCreateParam] = useSearchParamFlag("create");
  const createRole = ASSIGNABLE_ROLES.find((candidate) => candidate === createParam);
  const [createClicked, setCreateOpen] = useState(false);
  const createOpen = createClicked || createParam === "1" || createRole !== undefined;
  const [editingUser, setEditingUser] = useState<UserWithRoles | null>(null);
  const [deactivatingUser, setDeactivatingUser] = useState<UserWithRoles | null>(null);
  const [sessionsUser, setSessionsUser] = useState<UserWithRoles | null>(null);

  const roleOptions: SelectOption<Role | "">[] = [
    { value: "", label: t("adminPeople.users.list.allRoles") },
    ...(Object.entries(ROLE_LABEL_KEYS) as [Role, string][]).map(([value, key]) => ({
      value,
      label: t(key),
    })),
  ];

  const statusOptions: SelectOption<UsersFilters["status"]>[] = [
    { value: "", label: t("adminPeople.users.list.allStatuses") },
    ...(Object.entries(STATUS_LABEL_KEYS) as [UsersFilters["status"], string][]).map(
      ([value, key]) => ({ value, label: t(key) }),
    ),
  ];

  function statusLabel(status: UserWithRoles["status"]): string {
    const key = STATUS_LABEL_KEYS[status as keyof typeof STATUS_LABEL_KEYS];
    return key ? t(key) : status;
  }

  function roleLabel(role: string): string {
    const key = ROLE_LABEL_KEYS[role as Role];
    return key ? t(key) : role;
  }

  // A PARENT's school-defined record has its own page (`studentRecord:read`).
  const canReadRecords = permissions.has(PERMISSIONS.STUDENT_RECORD_READ);

  const columns: DataGridColumn<UserWithRoles>[] = [
    {
      id: "name",
      header: t("adminPeople.users.list.columns.name"),
      renderCell: (user) => user.display_name ?? "—",
    },
    {
      id: "email",
      header: t("adminPeople.users.list.columns.email"),
      renderCell: (user) => user.email ?? "—",
    },
    {
      id: "role",
      header: t("adminPeople.users.list.columns.role"),
      renderCell: (user) =>
        user.roles.map(roleLabel).join(t("adminPeople.common.listSeparator")) || "—",
    },
    {
      id: "status",
      header: t("adminPeople.users.list.columns.status"),
      renderCell: (user) => (
        <span className="users-list__status-pill" data-status={user.status}>
          {statusLabel(user.status)}
        </span>
      ),
    },
    {
      id: "last_login",
      header: t("adminPeople.users.list.columns.lastActive"),
      renderCell: (user) =>
        user.last_login_at
          ? formatDate(new Date(user.last_login_at), DATE_TIME_OPTIONS)
          : t("adminPeople.users.list.never"),
    },
    {
      id: "actions",
      header: t("adminPeople.users.list.columns.actions"),
      renderCell: (user) => (
        <div className="users-list__actions">
          <Button variant="tertiary" onClick={() => setEditingUser(user)}>
            {t("adminPeople.users.list.edit")}
          </Button>
          <Button variant="tertiary" onClick={() => setSessionsUser(user)}>
            {t("adminPeople.users.list.sessions")}
          </Button>
          {canReadRecords && user.roles.includes("PARENT") ? (
            <Link
              to={`/portal/admin/parents/${user.id}/records`}
              aria-label={t("records.principal.openParentRecords", {
                name: user.display_name ?? user.email ?? t("records.admin.parentFallback"),
              })}
            >
              {t("records.admin.openRecords")}
            </Link>
          ) : null}
          {user.status !== "suspended" && user.status !== "archived" ? (
            <Button variant="tertiary" onClick={() => setDeactivatingUser(user)}>
              {t("adminPeople.users.list.deactivate")}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  // One `POST /api/users` per row; each row is re-checked against the create modal's schema, so
  // the CSV can't assign a role the picker hides (`SUPER_ADMIN`).
  const importSpec: ImportSpec<CreateUserValues> = {
    templateName: "users",
    fields: [
      {
        key: "email",
        label: t("adminPeople.users.form.email"),
        required: true,
        type: "email",
        maxLength: 320,
        example: "teacher@example.edu",
      },
      {
        key: "display_name",
        label: t("adminPeople.users.form.displayName"),
        maxLength: 200,
        example: "Sara Haddad",
      },
      {
        key: "role",
        label: t("adminPeople.users.form.role"),
        required: true,
        options: ASSIGNABLE_ROLES,
        example: "INSTRUCTOR",
      },
    ],
    toRecord: (values) => {
      const result = createUserSchema.safeParse({
        email: values.email,
        display_name: values.display_name ?? undefined,
        role: values.role,
      });
      return result.success
        ? result.data
        : { errors: result.error.issues.map((issue) => t(issue.message)) };
    },
    create: async (body) => {
      const { data } = await api.POST("/api/users", { body });
      if (!data) throw new Error("User creation returned no data.");
      return data;
    },
  };

  return (
    <>
      <div className="users-list__header">
        <div>
          <h1>{t("adminPeople.users.list.title")}</h1>
          <p>{t("adminPeople.users.list.description")}</p>
        </div>
        <div className="users-list__header-actions">
          <ImportCsvButton
            spec={importSpec}
            title={t("adminPeople.users.list.importTitle")}
            onImported={() => void queryClient.invalidateQueries({ queryKey: USERS_LIST_KEY })}
          />
          <Button onClick={() => setCreateOpen(true)}>{t("adminPeople.users.list.newUser")}</Button>
        </div>
      </div>

      <div className="users-list__toolbar">
        <FilterBar
          searchLabel={t("adminPeople.users.list.searchLabel")}
          searchPlaceholder={t("adminPeople.users.list.searchPlaceholder")}
          search={searchInput}
          onSearchChange={setSearchInput}
          dateRange={dateRange}
          dateRangeLabel={t("adminPeople.users.list.createdBetween")}
          onDateRangeChange={setDateRange}
        />
        <Select
          label={t("adminPeople.users.list.roleFilter")}
          options={roleOptions}
          value={role}
          onChange={(value) => setRole(value)}
        />
        <Select
          label={t("adminPeople.users.list.statusFilter")}
          options={statusOptions}
          value={status}
          onChange={(value) => setStatus(value)}
        />
      </div>

      <DataGrid
        caption={t("adminPeople.users.list.caption")}
        columns={columns}
        rows={data?.users ?? []}
        getRowId={(user) => user.id}
        getRowLabel={(user) => user.display_name ?? user.email ?? user.id}
        loading={isPending}
        empty={isError ? t("adminPeople.users.list.loadError") : t("adminPeople.users.list.empty")}
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

      <CreateUserModal
        key={createRole ?? "default"}
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          clearCreateParam();
        }}
        {...(createRole ? { initialRole: createRole } : {})}
        canLinkChildren={permissions.has(PERMISSIONS.PARENT_LINK)}
        canFillRecords={permissions.has(PERMISSIONS.STUDENT_RECORD_UPDATE)}
      />

      <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} />

      <DeactivateUserDialog user={deactivatingUser} onClose={() => setDeactivatingUser(null)} />

      <UserSessionsPanel user={sessionsUser} onClose={() => setSessionsUser(null)} />
    </>
  );
}
