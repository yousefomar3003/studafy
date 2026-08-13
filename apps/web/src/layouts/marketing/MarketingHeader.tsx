import { NavLink } from "react-router-dom";

import { LinkButton } from "../../components/LinkButton";

import { MARKETING_NAV_ITEMS } from "./nav-items";

export interface MarketingHeaderProps {
  /** DOM id of the nav list this header's toggle controls. */
  navId: string;
  navOpen: boolean;
  onToggleNav: () => void;
}

/**
 * Public site header: brand, primary nav, and the two real entry points into the app — sign in for
 * existing schools, and a contact link for prospects. There is no self-serve signup route yet (only
 * `/auth/login` and invitation-based onboarding exist), so the primary CTA goes to the contact
 * section on the About page rather than a page that doesn't exist.
 */
export function MarketingHeader({ navId, navOpen, onToggleNav }: MarketingHeaderProps) {
  return (
    <header className="marketing-header">
      <div className="marketing-header__row">
        <NavLink to="/" className="marketing-header__brand" end>
          Studafy
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
          <span className="sf-visually-hidden">Toggle navigation</span>
        </button>

        <nav id={navId} aria-label="Primary" className="marketing-nav" data-open={navOpen}>
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
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="marketing-nav__actions">
            <LinkButton variant="tertiary" href="/auth/login">
              Sign in
            </LinkButton>
            <LinkButton variant="primary" href="/about#contact">
              Talk to us
            </LinkButton>
          </div>
        </nav>
      </div>
    </header>
  );
}
