import { api } from "../../../lib/api";

import type { InvitationRole } from "./schema";
import type { components } from "@studafy/api-client";

export type InvitationWithStatus = components["schemas"]["InvitationWithStatus"];
export type BulkInvite = components["schemas"]["BulkInviteResponse"];
export type BulkInviteRecipient = components["schemas"]["BulkInviteRecipient"];
export type BulkInviteRecipientStatus = BulkInviteRecipient["status"];

export interface InvitationsFilters {
  search: string;
  /** `""` means "all roles" — not a valid `InvitationRole`, stripped to `undefined` before the request. */
  role: InvitationRole | "";
  /** `""` means "all statuses". */
  status: components["schemas"]["InvitationWithStatus"]["status"] | "";
}

export const EMPTY_INVITATIONS_FILTERS: InvitationsFilters = { search: "", role: "", status: "" };

/** Query-key prefix shared by every cached page, so mutations can invalidate/patch all of them at once. */
export const INVITATIONS_LIST_KEY = ["invitations", "list"] as const;

export function invitationsListQueryKey(filters: InvitationsFilters, cursor: string | undefined) {
  return [...INVITATIONS_LIST_KEY, filters, cursor] as const;
}

const PAGE_SIZE = 25;

export async function fetchInvitationsPage(
  filters: InvitationsFilters,
  cursor: string | undefined,
) {
  const { data } = await api.GET("/api/invitations", {
    params: {
      query: {
        limit: PAGE_SIZE,
        cursor,
        role: filters.role || undefined,
        status: filters.status || undefined,
        search: filters.search || undefined,
      },
    },
  });
  // `readonly InvitationWithStatus[]` loses its array prototype through the generated response type
  // here — the same pre-existing `@studafy/api-client` typing gap `UsersListPage` works around, not a
  // shape mismatch. The annotation restores it without widening to `any`.
  return {
    invitations: (data?.invitations ?? []) as InvitationWithStatus[],
    next_cursor: data?.next_cursor ?? null,
  };
}

export const BULK_INVITES_LIST_KEY = ["bulk-invites", "list"] as const;

export function bulkInvitesListQueryKey(cursor: string | undefined) {
  return [...BULK_INVITES_LIST_KEY, cursor] as const;
}

const BULK_PAGE_SIZE = 20;

export async function fetchBulkInvitesPage(cursor: string | undefined) {
  const { data } = await api.GET("/api/invitations/bulk", {
    params: { query: { limit: BULK_PAGE_SIZE, cursor } },
  });
  return {
    bulkInvites: (data?.bulk_invites ?? []) as BulkInvite[],
    next_cursor: data?.next_cursor ?? null,
  };
}

/** Query-key prefix for one batch's recipients, shared across status filters so a retry can invalidate all of them at once. */
export function bulkInviteRecipientsListKey(bulkInviteId: string) {
  return ["bulk-invites", bulkInviteId, "recipients"] as const;
}

export function bulkInviteRecipientsQueryKey(
  bulkInviteId: string,
  status: BulkInviteRecipientStatus | "",
  cursor: string | undefined,
) {
  return [...bulkInviteRecipientsListKey(bulkInviteId), status, cursor] as const;
}

const RECIPIENTS_PAGE_SIZE = 50;

export async function fetchBulkInviteRecipientsPage(
  bulkInviteId: string,
  status: BulkInviteRecipientStatus | "",
  cursor: string | undefined,
) {
  const { data } = await api.GET("/api/invitations/bulk/{bulkInviteId}/recipients", {
    params: {
      path: { bulkInviteId },
      query: { limit: RECIPIENTS_PAGE_SIZE, cursor, status: status || undefined },
    },
  });
  return {
    recipients: (data?.recipients ?? []) as BulkInviteRecipient[],
    next_cursor: data?.next_cursor ?? null,
  };
}
