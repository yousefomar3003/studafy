import { Link } from "react-router-dom";

import { MARKETING_NAV_ITEMS } from "./nav-items";

const YEAR = new Date().getFullYear();

/**
 * Public site footer: sitemap, the same two entry points as the header, and the two legal pages
 * both app stores require to be reachable from the website.
 */
export function MarketingFooter() {
  return (
    <footer className="marketing-footer">
      <div className="marketing-footer__row">
        <div className="marketing-footer__brand">
          <span className="marketing-footer__brand-name">Studafy</span>
          <p className="marketing-footer__tagline">School operations, in one system.</p>
        </div>

        <nav aria-label="Footer" className="marketing-footer__nav">
          {MARKETING_NAV_ITEMS.map((item) => (
            <Link key={item.to} to={item.to}>
              {item.label}
            </Link>
          ))}
          <Link to="/auth/login">Sign in</Link>
          <Link to="/privacy">Privacy policy</Link>
          <Link to="/legal/delete-account">Delete your account</Link>
        </nav>
      </div>

      <p className="marketing-footer__copyright">&copy; {YEAR} Studafy. All rights reserved.</p>
    </footer>
  );
}
