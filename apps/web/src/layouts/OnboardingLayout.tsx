import { Outlet } from "react-router-dom";

import { useTranslation } from "../lib/i18n";

/** Layout for the onboarding route group. */
export function OnboardingLayout() {
  const { t } = useTranslation();

  return (
    <section aria-label={t("site.layouts.onboarding")} className="page-shell">
      <Outlet />
    </section>
  );
}
