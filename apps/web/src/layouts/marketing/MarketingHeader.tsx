import { NavLink } from "react-router-dom";

import { BrandLogo } from "../../components/BrandLogo";
import { LinkButton } from "../../components/LinkButton";
import { LocaleSwitcher } from "../../components/LocaleSwitcher";
import { usePublicAuthStatus } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";
import { useScrolled } from "../../lib/use-scrolled";
import { UserMenu } from "../portal/UserMenu";

import { MARKETING_NAV_ITEMS } from "./nav-items";

export interface MarketingHeaderProps {
  /** DOM id of the nav list this header's toggle controls. */
  navId: string;
  navOpen: boolean;
  onToggleNav: () => void;
}

/**
 * Public site header: brand, primary nav, and the entry points into the app: sign in for existing
 * schools (replaced by the account menu once signed in), sign-up, and a contact link for prospects.
 * A full-width bar at the top of the page that shrinks into a narrower rounded bar once the page
 * scrolls (`data-scrolled`, marketing-shell.css), and grows back at the top.
 */
export function MarketingHeader({ navId, navOpen, onToggleNav }: MarketingHeaderProps) {
  const { t } = useTranslation();
  const signedIn = usePublicAuthStatus() === "authenticated";
  const scrolled = useScrolled();

  return (
    <header className="marketing-header" data-scrolled={scrolled}>
      <div className="marketing-header__row">
        <NavLink to="/" className="marketing-header__brand" end>
          <BrandLogo />
        </NavLink>

        <button
          type="button"
          className="marketing-icon-button marketing-header__nav-toggle"
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

        <nav
          id={navId}
          aria-label={t("shell.primaryNavAriaLabel")}
          className="marketing-nav"
          data-open={navOpen}
        >
          <ul className="marketing-nav__list">
            {MARKETING_NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    isActive
                      ? "marketing-nav__link marketing-nav__link--active"
                      : "marketing-nav__link"
                  }
                >
                  {t(item.labelKey)}
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="marketing-nav__actions">
            <LocaleSwitcher />
            {signedIn ? (
              <UserMenu />
            ) : (
              <>
                <LinkButton variant="tertiary" href="/auth/login">
                  {t("site.marketing.header.signIn")}
                </LinkButton>
                <LinkButton variant="secondary" href="/signup">
                  {t("site.marketing.header.signUp")}
                </LinkButton>
              </>
            )}
            <LinkButton variant="primary" href="/about#contact">
              {t("site.marketing.header.talkToUs")}
            </LinkButton>
          </div>
        </nav>
      </div>
    </header>
  );
}
