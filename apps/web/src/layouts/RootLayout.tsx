import { Suspense } from "react";
import { Link, Outlet } from "react-router-dom";

import { Loading } from "../components/Loading";

/**
 * Shared shell wrapping every route group: skip link, primary navigation, and the main landmark.
 * The Suspense boundary covers lazily-loaded route groups.
 */
export function RootLayout() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header>
        <nav aria-label="Primary">
          <Link to="/">Home</Link>
          <Link to="/onboarding">Onboarding</Link>
          <Link to="/portal">Portal</Link>
          <Link to="/account">Account</Link>
        </nav>
      </header>
      <main id="main">
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
    </>
  );
}
