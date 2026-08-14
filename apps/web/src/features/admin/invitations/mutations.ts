import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import {
  BULK_INVITES_LIST_KEY,
  bulkInviteRecipientsListKey,
  INVITATIONS_LIST_KEY,
} from "./queries";

import type { InvitationWithStatus } from "./queries";
import type { CreateInvitationValues, InvitationRole } from "./schema";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

interface InvitationsListResult {
  invitations: InvitationWithStatus[];
  next_cursor: string | null;
}

type Snapshot = [QueryKey, InvitationsListResult | undefined][];

/**
 * Optimistic-update plumbing shared by revoke/resend below — same shape as the users feature's
 * `snapshotUserLists`/`restoreUserLists`/`patchUserInLists`. An invitation can appear on any cached
 * filter/cursor combination, so these operate on every query keyed under `INVITATIONS_LIST_KEY` at
 * once, not just the page currently on screen.
 */
function snapshotInvitationLists(queryClient: QueryClient): Snapshot {
  return queryClient.getQueriesData<InvitationsListResult>({ queryKey: INVITATIONS_LIST_KEY });
}

function restoreInvitationLists(queryClient: QueryClient, snapshot: Snapshot): void {
  for (const [key, data] of snapshot) {
    queryClient.setQueryData(key, data);
  }
}

function patchInvitationInLists(
  queryClient: QueryClient,
  invitationId: string,
  patch: (invitation: InvitationWithStatus) => InvitationWithStatus,
): void {
  queryClient.setQueriesData<InvitationsListResult>({ queryKey: INVITATIONS_LIST_KEY }, (data) => {
    if (!data) return data;
    return {
      ...data,
      invitations: data.invitations.map((invitation) =>
        invitation.id === invitationId ? patch(invitation) : invitation,
      ),
    };
  });
}

function invalidateInvitationLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: INVITATIONS_LIST_KEY });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** `POST /api/invitations` — issues a token, returned exactly once in the response. */
export function useCreateInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: CreateInvitationValues) => {
      const { data } = await api.POST("/api/invitations", {
        body: { email: values.email, role: values.role, expiry_days: values.expiry_days },
      });
      if (!data) throw new Error("Invitation creation returned no data.");
      return data;
    },
    onSuccess: () => invalidateInvitationLists(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Resend (calls the regenerate endpoint — see schema.ts: there is no separate resend endpoint,
// because the raw token is never stored server-side and so cannot be re-sent unchanged)
// ---------------------------------------------------------------------------

/**
 * `POST /api/invitations/{id}/regenerate` — atomically revokes the current invitation and issues a
 * fresh one with a new token. Labeled "Resend" in the UI; there is no way to re-deliver the original
 * token, so a new one is the only real option.
 */
export function useResendInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (invitationId: string) => {
      const { data } = await api.POST("/api/invitations/{id}/regenerate", {
        params: { path: { id: invitationId } },
      });
      if (!data) throw new Error("Resend returned no data.");
      return data;
    },
    onMutate: async (invitationId) => {
      await queryClient.cancelQueries({ queryKey: INVITATIONS_LIST_KEY });
      const snapshot = snapshotInvitationLists(queryClient);
      // The old row really is revoked immediately; the new row it's replaced by only exists once the
      // server responds, so it appears on refetch (onSettled) rather than being invented here.
      patchInvitationInLists(queryClient, invitationId, (invitation) => ({
        ...invitation,
        status: "revoked",
        revoked_at: new Date().toISOString(),
      }));
      return { snapshot };
    },
    onError: (_error, _invitationId, context) => {
      if (context) restoreInvitationLists(queryClient, context.snapshot);
    },
    onSettled: () => invalidateInvitationLists(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export function useRevokeInvitation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (invitationId: string) => {
      const { data } = await api.POST("/api/invitations/{id}/revoke", {
        params: { path: { id: invitationId } },
      });
      if (!data) throw new Error("Revoke returned no data.");
      return data;
    },
    onMutate: async (invitationId) => {
      await queryClient.cancelQueries({ queryKey: INVITATIONS_LIST_KEY });
      const snapshot = snapshotInvitationLists(queryClient);
      patchInvitationInLists(queryClient, invitationId, (invitation) => ({
        ...invitation,
        status: "revoked",
        revoked_at: new Date().toISOString(),
      }));
      return { snapshot };
    },
    onError: (_error, _invitationId, context) => {
      if (context) restoreInvitationLists(queryClient, context.snapshot);
    },
    onSettled: () => invalidateInvitationLists(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Bulk invite
// ---------------------------------------------------------------------------

export interface CreateBulkInviteVariables {
  role: InvitationRole;
  expiry_days?: number;
  recipients: string[];
}

export function useCreateBulkInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (values: CreateBulkInviteVariables) => {
      const { data } = await api.POST("/api/invitations/bulk", {
        body: {
          role: values.role,
          expiry_days: values.expiry_days,
          recipients: values.recipients.map((email) => ({ email })),
        },
      });
      if (!data) throw new Error("Bulk invite creation returned no data.");
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BULK_INVITES_LIST_KEY });
    },
  });
}

export function useRetryBulkInvite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (bulkInviteId: string) => {
      const { data } = await api.POST("/api/invitations/bulk/{bulkInviteId}/retry", {
        params: { path: { bulkInviteId } },
      });
      if (!data) throw new Error("Retry returned no data.");
      return data;
    },
    onSuccess: (_data, bulkInviteId) => {
      void queryClient.invalidateQueries({ queryKey: BULK_INVITES_LIST_KEY });
      void queryClient.invalidateQueries({ queryKey: bulkInviteRecipientsListKey(bulkInviteId) });
    },
  });
}
