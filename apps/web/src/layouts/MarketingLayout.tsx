import { Outlet } from "react-router-dom";

/** Layout for the public marketing route group. */
export function MarketingLayout() {
  return (
    <section aria-label="Marketing">
      <Outlet />
    </section>
  );
}
