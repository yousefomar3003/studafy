import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { Announcement, CreateAnnouncementBody } from "./queries";

/** `POST /api/announcements` — creates the announcement and, when its instant is already due,
 * publishes it in the same request (see the route's own doc comment in
 * apps/api/src/modules/announcements/routes.ts). The caller refreshes the history list on success
 * rather than this hook owning a query-cache invalidation, matching `audit`'s export mutation. */
export function useCreateAnnouncement() {
  return useMutation({
    mutationFn: async (body: CreateAnnouncementBody) => {
      const { data } = await api.POST("/api/announcements", { body });
      if (!data) throw new Error("Announcement creation returned no data.");
      return data as Announcement;
    },
  });
}
