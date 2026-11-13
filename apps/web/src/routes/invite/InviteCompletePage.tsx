import { useEffect, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Loading } from "../../components/Loading";
import { ACTIVATION_EVENTS, track } from "../../lib/analytics";
import {
  decodeAccessTokenRoles,
  resolveRoleHome,
  useAuthStatus,
  useSessionStore,
} from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { InvitationOutcome } from "./InvitationOutcome";

const REQUIRES_ADMIN_APPROVAL_OUTCOME = "requires_admin_approval";

/**
 * Invitation activation landing page (`/invite/:token/complete`).
 *
 * The invitation OAuth callback (`activation-oauth-routes.ts`) sends the browser here after the
 * provider round trip, in exactly one of two outcomes, distinguished by `?outcome`:
 *
 *   - Activated (no `outcome`): the HttpOnly refresh cookie is already set. This page recovers the
 *     access token the same way `/auth/callback` does (`store.restore()`), reads its `roles` claim
 *     for first-run routing only — never for authorization, the server enforces that independently
 *     on every request — and forwards to that role's home (`resolveRoleHome`).
 *   - `outcome=requires_admin_approval`: the verified identity's email diverged from the
 *     invitation's bound email. Nothing was activated and there is no session to recover; the
 *     invitation itself is untouched, so the same link still works once the mismatch is resolved.
 */
export default function InviteCompletePage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const requiresApproval = searchParams.get("outcome") === REQUIRES_ADMIN_APPROVAL_OUTCOME;

  const status = useAuthStatus();
  const store = useSessionStore();
  const navigate = useNavigate();

  // Only the activated path has a cookie to recover; the admin-approval path never issued one.
  useEffect(() => {
    if (!requiresApproval) {
      void store.restore();
    }
  }, [requiresApproval, store]);

  const approvalTracked = useRef(false);
  useEffect(() => {
    if (requiresApproval && !approvalTracked.current) {
      approvalTracked.current = true;
      track(ACTIVATION_EVENTS.ADMIN_APPROVAL_REQUIRED);
    }
  }, [requiresApproval]);

  const handled = useRef(false);
  useEffect(() => {
    if (requiresApproval || handled.current) {
      return;
    }
    if (status === "authenticated") {
      handled.current = true;
      track(ACTIVATION_EVENTS.SUCCEEDED);
      void (async () => {
        const accessToken = await store.getToken();
        const roles = accessToken ? decodeAccessTokenRoles(accessToken) : [];
        void navigate(resolveRoleHome(roles), { replace: true });
      })();
    } else if (status === "unauthenticated" || status === "expired") {
      // The redirect promised an activated session; if the cookie didn't come through, the honest
      // recovery is the ordinary sign-in flow rather than a stuck loader.
      handled.current = true;
      void navigate("/auth/login", { replace: true });
    }
  }, [status, navigate, store, requiresApproval]);

  if (requiresApproval) {
    return (
      <InvitationOutcome
        heading={t("onboarding.invite.approval.heading")}
        message={t("onboarding.invite.approval.message")}
        {...(token
          ? {
              action: {
                label: t("onboarding.invite.approval.retry"),
                href: `/invite/${token}`,
              },
            }
          : {})}
      />
    );
  }

  return <Loading />;
}
