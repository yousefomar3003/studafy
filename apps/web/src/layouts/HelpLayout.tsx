import { Link, Outlet } from "react-router-dom";

import { useTranslation } from "../lib/i18n";

/**
 * Public shell for the help center. It owns its header (brand + home) and is excluded from the
 * fallback cross-app nav in `RootLayout`, mirroring how `MarketingLayout` supplies its own chrome.
 */
export function HelpLayout() {
  const { t } = useTranslation();

  return (
    <div className="help-shell">
      <header className="help-shell__header">
        <Link to="/help" className="help-shell__brand">
          Studafy{" "}
          <span className="help-shell__brand-separator" aria-hidden="true">
            ·
          </span>{" "}
          <span>{t("help.title")}</span>
        </Link>
      </header>
      <Outlet />
    </div>
  );
}
