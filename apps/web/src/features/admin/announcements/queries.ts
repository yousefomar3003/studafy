import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";
import type { CursorPage } from "@studafy/ui";

export type Announcement = components["schemas"]["Announcement"];
export type AnnouncementStatus = Announcement["status"];
export type CreateAnnouncementBody = components["schemas"]["CreateAnnouncementBody"];

const PAGE_SIZE = 20;

/** One page of `GET /api/announcements`, shaped for `useCursorPagination`. Each item already
 * carries its own reach stats (`recipient_count` / `notified_count`) joined in by the API — see
 * `apps/api/src/modules/announcements/service.ts`'s `ANNOUNCEMENT_SELECT` — so no separate stats
 * request is needed for the history view. */
export async function fetchAnnouncementsPage(
  cursor: string | undefined,
  status: AnnouncementStatus | undefined,
): Promise<CursorPage<Announcement>> {
  const { data } = await api.GET("/api/announcements", {
    params: { query: { limit: PAGE_SIZE, cursor, status } },
  });
  return {
    items: (data?.items ?? []) as Announcement[],
    nextCursor: data?.next_cursor ?? undefined,
  };
}

export interface ClassOption {
  id: string;
  code: string;
}

const CLASS_PAGE_LIMIT = 100;

export function activeClassesQueryKey() {
  return ["academics", "classes", "active"] as const;
}

/** Backs the "class" audience picker. Only `active` classes — a `planned` or `completed` class has
 * no meaningful "students enrolled right now" audience for `resolveAnnouncementRecipientIds`
 * (`packages/announcements/src/index.ts`) to notify. */
export async function fetchActiveClasses(): Promise<ClassOption[]> {
  const { data } = await api.GET("/api/academics/classes", {
    params: { query: { status: "active", limit: CLASS_PAGE_LIMIT } },
  });
  // `readonly Class[]` loses its array prototype through the generated response type here — the
  // same pre-existing `@studafy/api-client` typing gap `NotificationBell.tsx` documents for
  // `notifications`. The annotation restores it without widening to `any`.
  const classes = (data?.classes ?? []) as readonly components["schemas"]["Class"][];
  return classes.map((klass) => ({ id: klass.id, code: klass.code }));
}
