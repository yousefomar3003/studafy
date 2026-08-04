import { Outlet } from "react-router-dom";

import { ApprovalQueueBadge } from "../components/ApprovalQueueBadge";

/**
 * Layout for the authenticated portal route group. The approval-queue badge is the reference
 * consumer of the realtime invalidation map: its `["approval-queue"]` query key is invalidated by
 * live `grades.published` events, so the count updates without polling.
 */
export function PortalLayout() {
  return (
    <section aria-label="Portal">
      <ApprovalQueueBadge />
      <Outlet />
    </section>
  );
}
