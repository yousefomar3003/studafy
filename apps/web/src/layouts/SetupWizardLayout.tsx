import { Outlet } from "react-router-dom";

/** Layout for the post-activation setup wizard route group. */
export function SetupWizardLayout() {
  return (
    <section aria-label="Setup wizard">
      <Outlet />
    </section>
  );
}
