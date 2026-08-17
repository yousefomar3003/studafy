import { Button, Card } from "@studafy/ui";

import type { FormEvent, ReactNode } from "react";

export interface SettingsCardProps {
  title: string;
  /** Section-level help text, shown under the title — in addition to the per-control `helperText`
   * each field carries, since "what does this section change" and "what does this one control do"
   * are different questions. */
  description: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  saving: boolean;
  saveLabel?: string;
  children: ReactNode;
}

/**
 * Shared chrome for every settings section: a labelled `Card` with its own form and save action, so
 * each setting persists independently rather than through one page-wide submit — matching how
 * `StudentProfilePage`'s per-section cards each own their save. The one local abstraction this
 * feature shares, same rationale as `DashboardTile` for the dashboard tiles.
 */
export function SettingsCard({
  title,
  description,
  onSubmit,
  saving,
  saveLabel = "Save changes",
  children,
}: SettingsCardProps) {
  return (
    <Card as="section" aria-label={title}>
      <Card.Header>
        <h2>{title}</h2>
        <p className="settings-card__description">{description}</p>
      </Card.Header>
      <form onSubmit={onSubmit} noValidate aria-label={title}>
        <Card.Body>{children}</Card.Body>
        <Card.Footer>
          <Button type="submit" loading={saving}>
            {saveLabel}
          </Button>
        </Card.Footer>
      </form>
    </Card>
  );
}
