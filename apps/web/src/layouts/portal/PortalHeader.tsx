import { Link } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

import { LocaleSwitcher } from "./LocaleSwitcher";
import { NotificationBell } from "./NotificationBell";
import { UserMenu } from "./UserMenu";

export interface PortalHeaderProps {
  /** DOM id of the sidebar nav this header's toggle controls. */
  navId: string;
  navOpen: boolean;
  onToggleNav: () => void;
}

/**
 * Single-tenant header: a static brand mark, no school switcher — Studafy is single-tenant per
 * deployment today, so there is nothing to switch between (see the ticket's own framing). The nav
 * toggle only does anything at the narrow breakpoint (`portal-shell.css` hides it above that width,
 * where the sidebar is always visible). "Studafy" is a proper noun and is never run through `t()`.
 */
export function PortalHeader({ navId, navOpen, onToggleNav }: PortalHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="portal-header">
      <button
        type="button"
        className="portal-icon-button portal-header__nav-toggle"
        aria-expanded={navOpen}
        aria-controls={navId}
        onClick={onToggleNav}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path
            d="M3 5.5h14M3 10h14M3 14.5h14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <span className="sf-visually-hidden">{t("shell.toggleNav")}</span>
      </button>

      <span className="portal-header__brand">Studafy</span>

      <div className="portal-header__actions">
        <Link to="/help" className="portal-icon-button" aria-label={t("help.open")}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M7.8 8a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.8-1.1 1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <circle cx="10" cy="14.2" r="1" fill="currentColor" />
          </svg>
        </Link>
        <LocaleSwitcher />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
