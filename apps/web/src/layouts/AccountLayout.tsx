import { Outlet } from "react-router-dom";

/** Layout for the account settings route group. */
export function AccountLayout() {
  return (
    <section aria-label="Account">
      <Outlet />
    </section>
  );
}
