import { isMobileOnly } from "@studafy/constants";
import { useEffect, useRef, type PropsWithChildren } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { Loading } from "../../components/Loading";

import { useAuthStatus, useSessionStore } from "./context";
import { clearReturnTo, setReturnTo } from "./return-to";

/**
 * Route guard for authenticated route groups (portal, account, …).
 *
 * On mount it asks the session store to check the refresh cookie (`restore()` is single-flight and
 * idempotent, so several guards across route groups never double-rotate). Until the check resolves
 * it renders the shared loader — a deep link with a live cookie must not flash the login page.
 * Once resolved:
 *   - `authenticated` -> the guarded content renders.
 *   - `unauthenticated`/`expired` -> the current route is saved to the return-to (`sessionStorage`,
 *     path only) and the browser is sent to `/auth/login`, with `reason=expired` when the session
 *     died mid-life so the login page can say so. The OAuth round trip then lands on `/auth/callback`,
 *     which consumes the return-to and restores the original route (deep-link acceptance criterion).
 *
 * A session holding only mobile-only roles (students, parents, teachers, attendance officers) is
 * signed out and sent to the "use the mobile app" page. The API already refuses such sessions at
 * sign-in and refresh; this catches an access token minted before that rule, for the minutes it has
 * left, so the portal never renders for it.
 *
 * The redirect is a `useEffect`, not a render branch, because the store's `restore()` is async: on
 * the very first render there is no answer yet, so a branch would redirect before the check runs.
 */
export function RequireAuth({ children }: PropsWithChildren) {
  const status = useAuthStatus();
  const store = useSessionStore();
  const navigate = useNavigate();
  const location = useLocation();

  // Re-check the cookie on mount (`restore()` is single-flight, so several guards across route
  // groups never double-rotate). A session that expired while the user browsed elsewhere is caught
  // on the way in.
  useEffect(() => {
    void store.restore();
  }, [store]);

  // A drop straight from `authenticated` to `unauthenticated` is a sign-out, not a deep link: the
  // page the old user was on must not become where the next sign-in on this tab lands.
  const previousStatus = useRef(status);
  useEffect(() => {
    const signedOut = previousStatus.current === "authenticated" && status === "unauthenticated";
    previousStatus.current = status;
    if (status === "unauthenticated" || status === "expired") {
      if (signedOut) {
        clearReturnTo();
      } else {
        setReturnTo(`${location.pathname}${location.search}`);
      }
      void navigate(status === "expired" ? "/auth/login?reason=expired" : "/auth/login", {
        replace: true,
      });
    }
  }, [status, location, navigate]);

  const mobileOnly = status === "authenticated" && isMobileOnly(store.getRoles());
  useEffect(() => {
    if (!mobileOnly) return;
    // Leave the guarded tree first, so the sign-out below cannot also bounce this guard to login.
    void navigate("/auth/error?code=WEB_ACCESS_MOBILE_ONLY", { replace: true });
    void store.logout();
  }, [mobileOnly, navigate, store]);

  if (status === "authenticated" && !mobileOnly) {
    return <>{children}</>;
  }
  return <Loading />;
}
