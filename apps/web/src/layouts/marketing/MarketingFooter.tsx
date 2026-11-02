import { Link } from "react-router-dom";

import { useAuthStatus } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { MARKETING_NAV_ITEMS } from "./nav-items";

const YEAR = new Date().getFullYear();

/**
 * Public site footer: sitemap, the same two entry points as the header, and the two legal pages
 * both app stores require to be reachable from the website.
 */
export function MarketingFooter() {
  const { t } = useTranslation();
  // MarketingHeader already restored the session for returning visitors; the footer just reads it.
  const signedIn = useAuthStatus() === "authenticated";

  return (
    <footer className="marketing-footer">
      <div className="marketing-footer__row">
        <div className="marketing-footer__brand">
          <span className="marketing-footer__brand-name">Studafy</span>
          <p className="marketing-footer__tagline">{t("site.marketing.footer.tagline")}</p>
        </div>

        <nav aria-label={t("site.marketing.footer.navAriaLabel")} className="marketing-footer__nav">
          {MARKETING_NAV_ITEMS.map((item) => (
            <Link key={item.to} to={item.to}>
              {t(item.labelKey)}
            </Link>
          ))}
          {signedIn ? (
            <Link to="/portal">{t("site.marketing.footer.portal")}</Link>
          ) : (
            <Link to="/auth/login">{t("site.marketing.footer.signIn")}</Link>
          )}
          <Link to="/privacy">{t("site.marketing.footer.privacy")}</Link>
          <Link to="/legal/delete-account">{t("site.marketing.footer.deleteAccount")}</Link>
        </nav>
      </div>

      <p className="marketing-footer__copyright">
        {t("site.marketing.footer.copyright", { year: YEAR })}
      </p>
    </footer>
  );
}
