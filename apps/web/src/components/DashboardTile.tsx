import { Card } from "@studafy/ui";

import type { ReactNode } from "react";

export type DashboardTileStatus = "pending" | "error" | "ready";

export interface DashboardTileProps {
  title: string;
  status: DashboardTileStatus;
  errorMessage: string;
  children: ReactNode;
}

/**
 * Shared chrome for every portal dashboard tile (admin, principal, ...): a labelled `Card` region
 * with a status-driven body. `@studafy/ui` has no stat/tile primitive, so this is the one shared
 * abstraction dashboard tiles use rather than each hand-rolling loading/error markup — each tile
 * still designs its own "ready but empty" state inside `children`, since what counts as empty
 * differs per tile.
 */
export function DashboardTile({ title, status, errorMessage, children }: DashboardTileProps) {
  return (
    <Card as="section" aria-label={title}>
      <Card.Header>
        <h2 className="dashboard-tile__title">{title}</h2>
      </Card.Header>
      <Card.Body>
        {status === "pending" ? (
          <p className="dashboard-tile__status" role="status">
            Loading…
          </p>
        ) : status === "error" ? (
          <p className="dashboard-tile__status dashboard-tile__status--error" role="alert">
            {errorMessage}
          </p>
        ) : (
          children
        )}
      </Card.Body>
    </Card>
  );
}
