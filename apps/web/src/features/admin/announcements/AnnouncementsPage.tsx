import { Tabs } from "@studafy/ui";
import { useState } from "react";

import { AnnouncementHistoryTable } from "./AnnouncementHistoryTable";
import { ComposeAnnouncementForm } from "./ComposeAnnouncementForm";

import "./announcements.css";

type AnnouncementsTab = "compose" | "history";

/**
 * Announcement management (ST-194): compose/publish with audience targeting (school/role/class)
 * and a mandatory flag, scheduled publishing, and history with reach stats.
 *
 * Route-gated on `notification:manage` (see `app/routes.tsx`), the same narrower-than-the-admin-
 * dashboard-default permission the API's own route uses (`apps/api/src/modules/announcements/routes.ts`).
 *
 * A successful compose switches to the History tab and bumps `historyRefreshToken`, which resets
 * `AnnouncementHistoryTable`'s cursor pagination back to page one — see that component's doc comment.
 */
export default function AnnouncementsPage() {
  const [tab, setTab] = useState<AnnouncementsTab>("compose");
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);

  return (
    <>
      <h1>Announcements</h1>
      <p>Compose and publish school notices, targeted by role or class, now or on a schedule.</p>

      <Tabs
        value={tab}
        defaultValue="compose"
        onChange={(value) => setTab(value as AnnouncementsTab)}
      >
        <Tabs.List>
          <Tabs.Tab value="compose">Compose</Tabs.Tab>
          <Tabs.Tab value="history">History</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="compose">
          <ComposeAnnouncementForm
            onCreated={() => {
              setHistoryRefreshToken((n) => n + 1);
              setTab("history");
            }}
          />
        </Tabs.Panel>

        <Tabs.Panel value="history">
          <AnnouncementHistoryTable refreshToken={historyRefreshToken} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
