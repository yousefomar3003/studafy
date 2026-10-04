import { Outlet } from "react-router-dom";

import { useTranslation } from "../lib/i18n";

/** Layout for the account settings route group. */
export function AccountLayout() {
  const { t } = useTranslation();

  return (
    <section aria-label={t("site.layouts.account")} className="page-shell">
      <Outlet />
    </section>
  );
}
