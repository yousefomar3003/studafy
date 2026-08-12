import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { Loading } from "../../components/Loading";
import { consumeReturnTo, useAuthStatus, useSessionStore } from "../../lib/auth";

/**
 * OAuth callback (`/auth/callback`).
 *
 * The API redirected the browser here after an OAuth round trip with the HttpOnly refresh cookie
 * set. The access token is recovered by {@link SessionStore.restore} — never exposed to the
 * browser — and the return-to saved by {@link RequireAuth} (or the portal) is restored, completing
 * the deep-link round trip. A failed exchange (no cookie) falls back to the login page.
 */
export default function CallbackPage() {
  const status = useAuthStatus();
  const store = useSessionStore();
  const navigate = useNavigate();

  useEffect(() => {
    void store.restore();
  }, [store]);

  const handled = useRef(false);
  useEffect(() => {
    if (status === "authenticated" && !handled.current) {
      handled.current = true;
      void navigate(consumeReturnTo() ?? "/portal", { replace: true });
    } else if ((status === "unauthenticated" || status === "expired") && !handled.current) {
      handled.current = true;
      void navigate(status === "expired" ? "/auth/login?reason=expired" : "/auth/login", {
        replace: true,
      });
    }
  }, [status, navigate]);

  return <Loading />;
}
