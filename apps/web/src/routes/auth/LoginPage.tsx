import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Loading } from "../../components/Loading";
import { consumeReturnTo, useAuthStatus, useOAuthLogin, useSessionStore } from "../../lib/auth";
import { SHOW_MOCK_LOGIN } from "../../lib/config";

/**
 * Login page (`/auth/login`).
 *
 * Two entry paths:
 *   - redirected here by {@link RequireAuth} when a guarded route was reached unauthenticated or
 *     with a dead session. The original route was saved to the return-to, and the OAuth round trip
 *     will restore it (`?reason=expired` when the session died mid-life).
 *   - visited directly. If the refresh cookie is still valid this page recovers the session itself
 *     (`restore()` is single-flight) and forwards to the return-to or the portal, so a user who
 *     merely navigated here with a live session never sees the provider buttons.
 */
export default function LoginPage() {
  const status = useAuthStatus();
  const store = useSessionStore();
  const beginOAuth = useOAuthLogin();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Re-check the cookie when this page is entered cold; harmless when already checked.
  useEffect(() => {
    void store.restore();
  }, [store]);

  const handled = useRef(false);
  useEffect(() => {
    if (status === "authenticated" && !handled.current) {
      handled.current = true;
      void navigate(consumeReturnTo() ?? "/portal", { replace: true });
    }
  }, [status, navigate]);

  if (status === "restoring" || status === "authenticated") {
    return <Loading />;
  }

  const sessionExpired = searchParams.get("reason") === "expired";

  return (
    <>
      <h1>Sign in</h1>
      {sessionExpired && <p role="status">Your session expired. Sign in again to continue.</p>}
      <p>
        <button type="button" onClick={() => beginOAuth("google")}>
          Continue with Google
        </button>
      </p>
      <p>
        <button type="button" onClick={() => beginOAuth("microsoft")}>
          Continue with Microsoft
        </button>
      </p>
      {SHOW_MOCK_LOGIN && (
        <p>
          <button
            type="button"
            onClick={() => beginOAuth("mock", searchParams.get("login_hint") ?? undefined)}
          >
            Continue with Mock
          </button>
        </p>
      )}
    </>
  );
}
