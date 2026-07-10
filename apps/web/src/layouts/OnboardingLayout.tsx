import { Outlet } from "react-router-dom";

/** Layout for the onboarding route group. */
export function OnboardingLayout() {
  return (
    <section aria-label="Onboarding">
      <Outlet />
    </section>
  );
}
