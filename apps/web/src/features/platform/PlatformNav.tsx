import { NavLink } from "react-router-dom";

import { useTranslation } from "../../lib/i18n";

const SECTIONS = [
  { to: "/portal/platform", labelKey: "platform.nav.overview", end: true },
  { to: "/portal/platform/schools", labelKey: "platform.nav.schools", end: false },
  { to: "/portal/platform/applications", labelKey: "platform.nav.applications", end: false },
  { to: "/portal/platform/inquiries", labelKey: "platform.nav.inquiries", end: false },
  { to: "/portal/platform/refunds", labelKey: "platform.nav.refunds", end: false },
  { to: "/portal/platform/finance", labelKey: "platform.nav.finance", end: false },
  { to: "/portal/platform/ai", labelKey: "platform.nav.ai", end: false },
  { to: "/portal/platform/plans", labelKey: "platform.nav.plans", end: false },
  { to: "/portal/platform/settings", labelKey: "platform.nav.settings", end: false },
  { to: "/portal/platform/users", labelKey: "platform.nav.users", end: false },
] as const;

/**
 * Section links shared by every platform console page. Plain links rather than `@studafy/ui` Tabs:
 * each section is its own route (deep-linkable, back-button friendly), not panels of one page.
 */
export function PlatformNav() {
  const { t } = useTranslation();
  return (
    <nav className="platform-nav" aria-label={t("platform.nav.ariaLabel")}>
      {SECTIONS.map((section) => (
        <NavLink key={section.to} to={section.to} end={section.end} className="platform-nav__link">
          {t(section.labelKey)}
        </NavLink>
      ))}
    </nav>
  );
}

/** Page heading + section nav, so every console page opens the same way. */
export function PlatformPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="platform-header">
      <p className="platform-header__eyebrow">{t("platform.eyebrow")}</p>
      <div className="platform-header__row">
        <div>
          <h1>{title}</h1>
          {description ? <p className="platform-header__description">{description}</p> : null}
        </div>
        {actions ? <div className="platform-header__actions">{actions}</div> : null}
      </div>
      <PlatformNav />
    </header>
  );
}

/** Lifecycle pill, colored by status. */
export function SchoolStatusPill({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <span className="platform-pill" data-status={status}>
      {t(`platform.status.${status}`, { defaultValue: status })}
    </span>
  );
}
