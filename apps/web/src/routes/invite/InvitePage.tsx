import { ApiError } from "@studafy/api-client";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams } from "react-router-dom";

import { Loading } from "../../components/Loading";
import { ACTIVATION_EVENTS, track } from "../../lib/analytics";
import { api } from "../../lib/api";
import { API_BASE_URL } from "../../lib/config";

import { InvitationOutcome } from "./InvitationOutcome";

import type { InvitationOutcomeProps } from "./InvitationOutcome";

/** The OAuth providers the invitation activation flow offers. Mirrors `activation-oauth-routes.ts`. */
export type InvitationOAuthProvider = "google" | "microsoft";

const PROVIDER_LABELS: Record<InvitationOAuthProvider, string> = {
  google: "Continue with Google",
  microsoft: "Continue with Microsoft",
};

/**
 * Builds the browser-redirect URL that starts the invitation OAuth flow for one provider
 * (`GET /api/auth/invitations/{token}/oauth/{provider}/start`, see `activation-oauth-routes.ts`).
 * A plain full-page navigation, not a fetch call — the provider round trip needs the whole browser,
 * and the API sets the session cookie on the redirect back, which no XHR/fetch response can do.
 */
export function activationOAuthStartUrl(token: string, provider: InvitationOAuthProvider): string {
  return `${API_BASE_URL}/api/auth/invitations/${encodeURIComponent(token)}/oauth/${provider}/start`;
}

/**
 * Actionable copy for each terminal invitation state (ST-180 AC: "all five failure states render
 * distinct actionable UI"). Keyed on the API's stable problem `code`
 * (`docs/security/invitation_verification_matrix.md`), never on prose, so a copy edit can never
 * silently detach from the branch it renders for.
 */
// A Map, not a plain object: `code` is a string the server put on the wire, and a Map sidesteps any
// prototype-property lookup concern that indexing a literal object with untrusted-shaped input would
// raise, with no loss of clarity.
const FAILURE_COPY = new Map<string, Omit<InvitationOutcomeProps, "requestId">>([
  [
    "INVITATION_INVALID",
    {
      heading: "This invitation link isn't valid",
      message: "Double-check the link your school sent you, or ask them to send a new one.",
    },
  ],
  [
    "EXPIRED",
    {
      heading: "This invitation has expired",
      message: "Invitations are time-limited. Ask your school administrator to send you a new one.",
    },
  ],
  [
    "REVOKED",
    {
      heading: "This invitation was revoked",
      message:
        "Your school administrator canceled this invitation. Contact them if you believe this is a mistake.",
    },
  ],
  [
    "CONSUMED",
    {
      heading: "This invitation was already used",
      message: "This link has already activated an account. If that was you, sign in instead.",
      action: { label: "Sign in", href: "/auth/login" },
    },
  ],
  [
    "SCHOOL_SUSPENDED",
    {
      heading: "Your school's account is suspended",
      message:
        "Onboarding is paused while your school's account is suspended. Contact your school administrator.",
    },
  ],
]);

const GENERIC_FAILURE: Omit<InvitationOutcomeProps, "requestId"> = {
  heading: "We couldn't verify this invitation",
  message: "Something went wrong on our end. Please try again in a moment.",
};

/**
 * Public invitation activation page (`/invite/:token`).
 *
 * Read-only up front: it verifies the token against `GET /api/auth/invitations/{token}/verify`
 * (no side effects — `invitation_verification_matrix.md`) and renders one of six outcomes — the
 * five lifecycle failures the endpoint enumerates plus the happy path. A valid invitation offers the
 * two provider buttons; activation itself happens server-side after the provider redirect
 * (`activation-oauth-routes.ts`), which lands the browser back here on failure (this page re-verifies
 * and renders whatever the invitation's state has become — one rendering path for every failure,
 * first visit or retry alike) or on `/invite/:token/complete` on success.
 */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();

  const { data, error, isPending } = useQuery({
    queryKey: ["invitation-verify", token],
    queryFn: async () => {
      const { data } = await api.GET("/api/auth/invitations/{token}/verify", {
        params: { path: { token: token! } },
      });
      return data;
    },
    enabled: Boolean(token),
    retry: false,
  });

  const code = error instanceof ApiError ? error.code : null;

  // Fires once per settled outcome — `data`/`code` only change identity when the query transitions
  // out of pending, not on every re-render.
  useEffect(() => {
    if (isPending) return;
    if (data) {
      track(ACTIVATION_EVENTS.INVITATION_VIEWED);
    } else {
      track(ACTIVATION_EVENTS.INVITATION_INVALID, { reason: code ?? "unknown" });
    }
  }, [isPending, data, code]);

  if (!token) {
    return <InvitationOutcome {...FAILURE_COPY.get("INVITATION_INVALID")!} />;
  }

  if (isPending) {
    return <Loading />;
  }

  if (error || !data) {
    const copy = (code && FAILURE_COPY.get(code)) || GENERIC_FAILURE;
    const requestId = error instanceof ApiError ? error.request_id : null;
    return <InvitationOutcome {...copy} requestId={requestId} />;
  }

  return (
    <>
      <h1>You&rsquo;re invited to {data.schoolName}</h1>
      <p>
        Activating {data.emailHint}. Choose how you&rsquo;d like to sign in to finish setting up
        your account.
      </p>
      <p>
        <a
          href={activationOAuthStartUrl(token, "google")}
          onClick={() => track(ACTIVATION_EVENTS.OAUTH_STARTED, { provider: "google" })}
        >
          {PROVIDER_LABELS.google}
        </a>
      </p>
      <p>
        <a
          href={activationOAuthStartUrl(token, "microsoft")}
          onClick={() => track(ACTIVATION_EVENTS.OAUTH_STARTED, { provider: "microsoft" })}
        >
          {PROVIDER_LABELS.microsoft}
        </a>
      </p>
    </>
  );
}
