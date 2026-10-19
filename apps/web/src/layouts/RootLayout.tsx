import { Suspense } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { BrandLogo } from "../components/BrandLogo";
import { Loading } from "../components/Loading";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import { useTranslation } from "../lib/i18n";
import { ScrollToTopOnNavigate, useScrolled } from "../lib/use-scrolled";

import { MARKETING_NAV_ITEMS } from "./marketing/nav-items";

import "./root-shell.css";

// Every route that renders inside `MarketingLayout` (see `app/routes.tsx`): the nav pages plus the
// public legal pages, which are linked from the footer and app-store listings rather than the nav,
// and the school sign-up pages (`/signup`, `/signup/apply`), reached from the header's "Sign up".
const MARKETING_PATHS = new Set(MARKETING_NAV_ITEMS.map((item) => item.to));
const MARKETING_PATH_PREFIXES = ["/privacy", "/legal/", "/signup"];

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
  const isMarketing =
    MARKETING_PATHS.has(pathname) ||
    MARKETING_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const isHelp = pathname.startsWith("/help");
  // The sign-in pages are a designed, self-contained screen; the placeholder nav would sit on top.
  const isAuth = pathname.startsWith("/auth");
  // PortalLayout renders its own header (brand, search, user menu); a second bar would stack on it.
  const isPortal = pathname.startsWith("/portal");
  const scrolled = useScrolled();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {t("shell.skipToContent")}
      </a>
      {!isMarketing && !isHelp && !isAuth && !isPortal && (
        <header className="root-nav" data-scrolled={scrolled}>
          <div className="root-nav__inner">
            <Link to="/" className="root-nav__brand" aria-label={t("shell.homeLink")}>
              <BrandLogo />
            </Link>
            <nav aria-label={t("shell.primaryNavAriaLabel")} className="root-nav__links">
              <NavLink to="/" end className="root-nav__link">
                {t("rootNav.home")}
              </NavLink>
              <NavLink to="/onboarding" className="root-nav__link">
                {t("rootNav.onboarding")}
              </NavLink>
              <NavLink to="/portal" className="root-nav__link">
                {t("rootNav.portal")}
              </NavLink>
              <NavLink to="/account" className="root-nav__link">
                {t("rootNav.account")}
              </NavLink>
            </nav>
            <LocaleSwitcher />
          </div>
        </header>
      )}
      <main id="main" className="app-shell__main" data-scroll-root="">
        <Suspense fallback={<Loading />}>
          {/* Inside the boundary so the rewind waits for a lazy page to load (see the hook). */}
          <ScrollToTopOnNavigate />
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
