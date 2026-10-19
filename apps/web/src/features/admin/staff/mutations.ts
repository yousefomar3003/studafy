import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import { STAFF_INVITATIONS_KEY } from "./queries";

import type { StaffRole } from "./queries";

function useInvalidateOnSettled() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: STAFF_INVITATIONS_KEY });
}

/** `POST /api/invitations` — the API emails the invitee their sign-in link (outbox `invitation.sent`). */
export function useInviteStaff() {
  const onSettled = useInvalidateOnSettled();
  return useMutation({
    mutationFn: async (body: { email: string; role: StaffRole }) => {
      const { data } = await api.POST("/api/invitations", { body });
      return data;
    },
    onSettled,
  });
}

/** Revokes the old link and emails a fresh one — for a lost email or an expired invitation. */
export function useResendStaffInvitation() {
  const onSettled = useInvalidateOnSettled();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.POST("/api/invitations/{id}/regenerate", {
        params: { path: { id } },
      });
      return data;
    },
    onSettled,
  });
}

export function useRevokeStaffInvitation() {
  const onSettled = useInvalidateOnSettled();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.POST("/api/invitations/{id}/revoke", {
        params: { path: { id } },
      });
      return data;
    },
    onSettled,
  });
}
