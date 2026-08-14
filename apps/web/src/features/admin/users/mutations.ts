import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { USERS_LIST_KEY } from "./queries";

import type { UserWithRoles } from "./queries";
import type { CreateUserValues } from "./schema";
import type { Role } from "@studafy/constants";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

interface UsersListResult {
  users: UserWithRoles[];
  next_cursor: string | null;
}

type Snapshot = [QueryKey, UsersListResult | undefined][];

/**
 * Optimistic-update plumbing shared by every mutation below.
 *
 * A user can appear on any cached filter/cursor combination, so `snapshotUserLists` /
 * `restoreUserLists` operate on every query keyed under `USERS_LIST_KEY` at once (TanStack's
 * multi-query rollback pattern), not just the page currently on screen. `onMutate` snapshots before
 * writing the optimistic patch and returns it as mutation context; `onError` restores it verbatim;
 * `onSettled` invalidates so the next render reconciles with the server regardless of outcome.
 */
function snapshotUserLists(queryClient: QueryClient): Snapshot {
  return queryClient.getQueriesData<UsersListResult>({ queryKey: USERS_LIST_KEY });
}

function restoreUserLists(queryClient: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) {
    queryClient.setQueryData(key, data);
  }
}

function patchUserInLists(
  queryClient: QueryClient,
  userId: string,
  patch: (user: UserWithRoles) => UserWithRoles,
): void {
  queryClient.setQueriesData<UsersListResult>({ queryKey: USERS_LIST_KEY }, (data) => {
    if (!data) return data;
    return { ...data, users: data.users.map((user) => (user.id === userId ? patch(user) : user)) };
  });
}

function invalidateUserLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: USERS_LIST_KEY });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * A locally-generated id for the optimistic row, replaced by the real one once the server responds
 * (or removed on rollback). Prefixed so it can never collide with a real UUID.
 */
function tempId(): string {
  return `optimistic-${crypto.randomUUID()}`;
}

export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: CreateUserValues) => {
      const { data } = await api.POST("/api/users", { body: values });
      if (!data) throw new Error("User creation returned no data.");
      return data;
    },
    onMutate: async (values) => {
      await queryClient.cancelQueries({ queryKey: USERS_LIST_KEY });
      const snapshot = snapshotUserLists(queryClient);

      // New users sort first (the list orders by created_at DESC), so the optimistic row only
      // belongs on whichever cached page has no cursor — i.e. the first page of each filter set.
      const optimistic: UserWithRoles = {
        id: tempId(),
        school_id: "",
        email: values.email,
        display_name: values.display_name ?? null,
        status: "invited",
        roles: [values.role as Role],
        email_verified_at: null,
        last_login_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      queryClient.setQueriesData<UsersListResult>(
        { queryKey: USERS_LIST_KEY, predicate: (query) => query.queryKey.at(-1) === undefined },
        (data) => (data ? { ...data, users: [optimistic, ...data.users] } : data),
      );

      return { snapshot };
    },
    onError: (_error, _values, context) => {
      if (context) restoreUserLists(queryClient, context.snapshot);
    },
    onSettled: () => invalidateUserLists(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Update profile (display name)
// ---------------------------------------------------------------------------

export interface UpdateUserVariables {
  userId: string;
  display_name: string;
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, display_name }: UpdateUserVariables) => {
      const { data } = await api.PATCH("/api/users/{userId}", {
        params: { path: { userId } },
        body: { display_name },
      });
      return data;
    },
    onMutate: async ({ userId, display_name }) => {
      await queryClient.cancelQueries({ queryKey: USERS_LIST_KEY });
      const snapshot = snapshotUserLists(queryClient);
      patchUserInLists(queryClient, userId, (user) => ({ ...user, display_name }));
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      if (context) restoreUserLists(queryClient, context.snapshot);
    },
    onSettled: () => invalidateUserLists(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

export interface UpdateUserRoleVariables {
  userId: string;
  role: Role;
}

export function useUpdateUserRole() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId, role }: UpdateUserRoleVariables) => {
      const { data } = await api.PATCH("/api/users/{userId}/role", {
        params: { path: { userId } },
        body: { role },
      });
      return data;
    },
    onMutate: async ({ userId, role }) => {
      await queryClient.cancelQueries({ queryKey: USERS_LIST_KEY });
      const snapshot = snapshotUserLists(queryClient);
      patchUserInLists(queryClient, userId, (user) => ({ ...user, roles: [role] }));
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      if (context) restoreUserLists(queryClient, context.snapshot);
    },
    onSettled: () => invalidateUserLists(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

export function useDeactivateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (userId: string) => {
      const { data } = await api.PATCH("/api/users/{userId}/deactivate", {
        params: { path: { userId } },
      });
      if (!data) throw new Error("Deactivation returned no data.");
      return data;
    },
    onMutate: async (userId) => {
      await queryClient.cancelQueries({ queryKey: USERS_LIST_KEY });
      const snapshot = snapshotUserLists(queryClient);
      patchUserInLists(queryClient, userId, (user) => ({ ...user, status: "suspended" }));
      return { snapshot };
    },
    onError: (_error, _userId, context) => {
      if (context) restoreUserLists(queryClient, context.snapshot);
    },
    onSettled: () => invalidateUserLists(queryClient),
  });
}
