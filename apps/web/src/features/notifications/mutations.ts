import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../lib/api";

import { NOTIFICATION_PREFERENCES_QUERY_KEY, NOTIFICATIONS_QUERY_KEY } from "./queries";

import type { components } from "@studafy/api-client";

function invalidateInbox(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
}

/** Marks one notification read. Shared by the header bell and the full inbox page. */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (notificationId: string) => {
      const { data } = await api.POST("/api/notifications/{notificationId}/read", {
        params: { path: { notificationId } },
      });
      return data;
    },
    onSuccess: () => invalidateInbox(queryClient),
  });
}

/** Marks every unread notification read. Shared by the header bell and the full inbox page. */
export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/notifications/read-all");
      return data;
    },
    onSuccess: () => invalidateInbox(queryClient),
  });
}

export type NotificationPreferenceUpdate = components["schemas"]["NotificationPreferenceUpdate"];

export interface UpdatePreferencesInput {
  preferences?: NotificationPreferenceUpdate[];
  attendance_alert_threshold?: number | null;
}

/**
 * Applies a batch of (type, channel) cell changes and/or the personal attendance-alert threshold in
 * one call, matching the request schema's own batch shape (`preferences: [...]`) rather than firing
 * one request per toggled checkbox.
 */
export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdatePreferencesInput) => {
      const { data } = await api.PATCH("/api/notification-preferences", { body: input });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY });
    },
  });
}
