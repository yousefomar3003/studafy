import { Outlet } from "react-router-dom";

import { useTranslation } from "../lib/i18n";

/** Layout for the post-activation setup wizard route group. */
export function SetupWizardLayout() {
  const { t } = useTranslation();

  return (
    <section aria-label={t("site.layouts.setupWizard")} className="page-shell">
      <Outlet />
    </section>
  );
}
