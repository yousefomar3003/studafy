import { ROLES } from "@studafy/constants";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type StaffInvitation = components["schemas"]["InvitationWithStatus"];

/**
 * School-leadership roles an admin invites from this page. Each invitee signs in with Google or
 * Microsoft (Outlook) through the invitation link — there is no password to set.
 */
export const STAFF_ROLES = [ROLES.PRINCIPAL, ROLES.FINANCE] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_INVITATIONS_KEY = ["invitations", "staff"] as const;

/** Upper bound per role; a school has a handful of principals and finance staff, not pages of them. */
const PER_ROLE_LIMIT = 100;

async function fetchStaffInvitations(): Promise<StaffInvitation[]> {
  const pages = await Promise.all(
    STAFF_ROLES.map(async (role) => {
      const { data } = await api.GET("/api/invitations", {
        params: { query: { role, limit: PER_ROLE_LIMIT } },
      });
      // Same generated readonly-array typing gap as `admin/users/queries.ts`.
      return (data?.invitations ?? []) as StaffInvitation[];
    }),
  );
  return pages.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function useStaffInvitationsQuery() {
  return useQuery({ queryKey: STAFF_INVITATIONS_KEY, queryFn: fetchStaffInvitations });
}
