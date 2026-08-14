import { Card } from "@studafy/ui";

import type { ReactNode } from "react";

export type AdminTileStatus = "pending" | "error" | "ready";

export interface AdminTileProps {
  title: string;
  status: AdminTileStatus;
  errorMessage: string;
  children: ReactNode;
}

/**
 * Shared chrome for every admin dashboard tile: a labelled `Card` region with a status-driven
 * body. `@studafy/ui` has no stat/tile primitive, so this is the one local abstraction the tiles
 * share rather than each hand-rolling loading/error markup — each tile still designs its own
 * "ready but empty" state inside `children`, since what counts as empty differs per tile.
 */
export function AdminTile({ title, status, errorMessage, children }: AdminTileProps) {
  return (
    <Card as="section" aria-label={title}>
      <Card.Header>
        <h2 className="admin-tile__title">{title}</h2>
      </Card.Header>
      <Card.Body>
        {status === "pending" ? (
          <p className="admin-tile__status" role="status">
            Loading…
          </p>
        ) : status === "error" ? (
          <p className="admin-tile__status admin-tile__status--error" role="alert">
            {errorMessage}
          </p>
        ) : (
          children
        )}
      </Card.Body>
    </Card>
  );
}
