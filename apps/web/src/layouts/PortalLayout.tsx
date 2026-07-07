import { Outlet } from "react-router-dom";

/** Layout for the authenticated portal route group. */
export function PortalLayout() {
  return (
    <section aria-label="Portal">
      <Outlet />
    </section>
  );
}
