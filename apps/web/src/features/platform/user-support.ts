import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import { PLATFORM_KEY } from "./queries";

import type { components } from "@studafy/api-client";

export type PlatformSupportUser = components["schemas"]["PlatformSupportUser"];

/** The console's per-account support actions; each one's request path segment. */
export const SUPPORT_ACTIONS = [
  "resendInvitation",
  "signOut",
  "unlock",
  "deactivate",
  "reactivate",
] as const;
export type SupportActionName = (typeof SUPPORT_ACTIONS)[number];

export const supportUserKey = (schoolId: string, userId: string) =>
  [...PLATFORM_KEY, "support-user", schoolId, userId] as const;

/** `GET /api/platform/schools/{schoolId}/users/{userId}` -- the read-only support panel. */
export function useSupportUserQuery(schoolId: string, userId: string) {
  return useQuery({
    queryKey: supportUserKey(schoolId, userId),
    queryFn: async () => {
      const { data } = await api.GET("/api/platform/schools/{schoolId}/users/{userId}", {
        params: { path: { schoolId, userId } },
      });
      if (!data) throw new Error("Support panel returned no data.");
      return data as PlatformSupportUser;
    },
    enabled: schoolId !== "" && userId !== "",
  });
}

async function runAction(
  action: SupportActionName,
  schoolId: string,
  userId: string,
  reason: string,
): Promise<unknown> {
  const params = { path: { schoolId, userId } };
  const body = { reason };
  switch (action) {
    case "resendInvitation":
      return (
        await api.POST("/api/platform/schools/{schoolId}/users/{userId}/invitation/resend", {
          params,
          body,
        })
      ).data;
    case "signOut":
      return (
        await api.POST("/api/platform/schools/{schoolId}/users/{userId}/sessions/revoke", {
          params,
          body,
        })
      ).data;
    case "unlock":
      return (
        await api.POST("/api/platform/schools/{schoolId}/users/{userId}/unlock", { params, body })
      ).data;
    case "deactivate":
      return (
        await api.POST("/api/platform/schools/{schoolId}/users/{userId}/deactivate", {
          params,
          body,
        })
      ).data;
    case "reactivate":
      return (
        await api.POST("/api/platform/schools/{schoolId}/users/{userId}/reactivate", {
          params,
          body,
        })
      ).data;
  }
}

/** Runs one support action with its reason, then refreshes the panel and the lookup results. */
export function useSupportAction(schoolId: string, userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, reason }: { action: SupportActionName; reason: string }) => {
      const data = await runAction(action, schoolId, userId, reason);
      if (!data) throw new Error("Support action returned no data.");
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: supportUserKey(schoolId, userId) });
      void queryClient.invalidateQueries({ queryKey: [...PLATFORM_KEY, "user-lookup"] });
    },
  });
}

/** Which actions make sense for this account right now. */
export function availableActions(user: PlatformSupportUser): SupportActionName[] {
  if (!user.actionable) return [];
  const actions: SupportActionName[] = [];
  if (user.status === "invited" && user.email) actions.push("resendInvitation");
  if (user.activeSessions > 0) actions.push("signOut");
  if (user.signIn.locked || user.signIn.failedAttempts > 0) actions.push("unlock");
  if (user.status === "suspended") actions.push("reactivate");
  else if (user.status !== "archived" && !user.isSelf) actions.push("deactivate");
  return actions;
}
