import { NavLink } from "react-router-dom";

import { ShortcutGroupList } from "../../components/home/SummaryStrip";
import { useTranslation } from "../../lib/i18n";

import type { ShortcutGroup } from "../../components/home/SummaryStrip";

// The console's sections, sorted into a few groups so they fit on one line — the same grouped row
// the school admin, principal, and finance homes open with. Overview stands alone, ahead of them.
const SECTION_GROUPS = [
  {
    key: "schools",
    links: [
      { key: "schools", to: "/portal/platform/schools", labelKey: "platform.nav.schools" },
      {
        key: "applications",
        to: "/portal/platform/applications",
        labelKey: "platform.nav.applications",
      },
      { key: "inquiries", to: "/portal/platform/inquiries", labelKey: "platform.nav.inquiries" },
      { key: "users", to: "/portal/platform/users", labelKey: "platform.nav.users" },
    ],
  },
  {
    key: "billing",
    links: [
      { key: "finance", to: "/portal/platform/finance", labelKey: "platform.nav.finance" },
      { key: "refunds", to: "/portal/platform/refunds", labelKey: "platform.nav.refunds" },
      {
        key: "licenses",
        to: "/portal/platform/licenses",
        labelKey: "platformLicensing.nav.licenses",
      },
      { key: "quotes", to: "/portal/platform/quotes", labelKey: "platformLicensing.nav.quotes" },
      {
        key: "payments",
        to: "/portal/platform/payments",
        labelKey: "platformLicensing.nav.payments",
      },
      { key: "grants", to: "/portal/platform/grants", labelKey: "platformLicensing.nav.grants" },
    ],
  },
  {
    key: "catalog",
    links: [
      { key: "plans", to: "/portal/platform/plans", labelKey: "platform.nav.plans" },
      { key: "tiers", to: "/portal/platform/tiers", labelKey: "platformLicensing.nav.tiers" },
      {
        key: "features",
        to: "/portal/platform/features",
        labelKey: "platformLicensing.nav.features",
      },
      { key: "pricing", to: "/portal/platform/pricing", labelKey: "platformLicensing.nav.pricing" },
    ],
  },
  {
    key: "ai",
    links: [
      { key: "ai", to: "/portal/platform/ai", labelKey: "platform.nav.ai" },
      {
        key: "aiProgramme",
        to: "/portal/platform/ai-programme",
        labelKey: "platformLicensing.nav.aiProgramme",
        // Its schools and statements are sibling sections, so only the exact route is this one.
        end: true,
      },
      {
        key: "aiProgrammeSchools",
        to: "/portal/platform/ai-programme/schools",
        labelKey: "platformLicensing.nav.aiProgrammeSchools",
      },
      {
        key: "aiProgrammeStatements",
        to: "/portal/platform/ai-programme/statements",
        labelKey: "platformLicensing.nav.aiProgrammeStatements",
      },
    ],
  },
  {
    key: "operations",
    links: [
      {
        key: "announcements",
        to: "/portal/platform/announcements",
        labelKey: "platform.nav.announcements",
      },
      { key: "activity", to: "/portal/platform/activity", labelKey: "platform.nav.activity" },
      { key: "health", to: "/portal/platform/health", labelKey: "platform.nav.health" },
      { key: "flags", to: "/portal/platform/flags", labelKey: "platform.nav.flags" },
      {
        key: "importSignals",
        to: "/portal/platform/import-signals",
        labelKey: "platform.nav.importSignals",
      },
      { key: "settings", to: "/portal/platform/settings", labelKey: "platform.nav.settings" },
    ],
  },
] as const;

/**
 * Section links shared by every platform console page: Overview, then the grouped sections. Each
 * section is its own route (deep-linkable, back-button friendly), not panels of one page; the
 * group holding the current page is marked, so the row still says where you are.
 */
export function PlatformNav() {
  const { t } = useTranslation();
  const groups: ShortcutGroup[] = SECTION_GROUPS.map((group) => ({
    key: group.key,
    label: t(`platform.nav.groups.${group.key}`),
    links: group.links.map((link) => ({
      key: link.key,
      to: link.to,
      end: "end" in link ? link.end : false,
      label: t(link.labelKey),
    })),
  }));
  return (
    <nav className="platform-nav" aria-label={t("platform.nav.ariaLabel")}>
      <ShortcutGroupList
        groups={groups}
        leading={
          <NavLink to="/portal/platform" end className="home-shortcut-group__trigger">
            {t("platform.nav.overview")}
          </NavLink>
        }
      />
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
