import { useRef } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { useTranslation } from "../lib/i18n";
import { useHeadingTitle } from "../lib/use-heading-title";

import { BackLink } from "./portal/PortalBackLink";

/**
 * Layout for the account settings route group, with the same "← Back" as the portal: the account
 * page itself is a sidebar page and gets none; each of its sub-pages goes back to it. The browser
 * tab is named after the open page's heading, as in the portal.
 */
export function AccountLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const onAccount = (pathname.replace(/\/+$/, "") || "/") === "/account";
  const sectionRef = useRef<HTMLElement>(null);
  useHeadingTitle(sectionRef);

  return (
    <section ref={sectionRef} aria-label={t("site.layouts.account")} className="page-shell">
      {onAccount ? null : <BackLink to="/account" />}
      <Outlet />
    </section>
  );
}
