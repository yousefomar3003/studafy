import { Suspense } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

import { Loading } from "../components/Loading";
import { useTranslation } from "../lib/i18n";

import { MARKETING_NAV_ITEMS } from "./marketing/nav-items";

const MARKETING_PATHS = new Set(MARKETING_NAV_ITEMS.map((item) => item.to));

/**
 * Shared shell wrapping every route group: skip link, primary navigation, and the main landmark.
 * The Suspense boundary covers lazily-loaded route groups.
 *
 * The internal `<nav>` below is placeholder cross-app navigation for the authenticated groups
 * (onboarding/portal/account), none of which have their own header yet apart from `PortalLayout`.
 * It's suppressed on marketing routes, which bring their own real header/footer via
 * `MarketingLayout` — stacking this unstyled dev nav above a designed public page would read as
 * broken rather than intentional.
 */
export function RootLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const isMarketing = MARKETING_PATHS.has(pathname);

  return (
    <>
      <a className="skip-link" href="#main">
        {t("shell.skipToContent")}
      </a>
      {!isMarketing && (
        <header>
          <nav aria-label={t("shell.primaryNavAriaLabel")}>
            <Link to="/">{t("rootNav.home")}</Link>
            <Link to="/onboarding">{t("rootNav.onboarding")}</Link>
            <Link to="/portal">{t("rootNav.portal")}</Link>
            <Link to="/account">{t("rootNav.account")}</Link>
          </nav>
        </header>
      )}
      <main id="main">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}
