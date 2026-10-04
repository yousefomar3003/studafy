import { ApiError } from "@studafy/api-client";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { Loading } from "../../components/Loading";
import { ACTIVATION_EVENTS, track } from "../../lib/analytics";
import { api } from "../../lib/api";
import { API_BASE_URL, SHOW_MOCK_LOGIN } from "../../lib/config";
import { useTranslation } from "../../lib/i18n";

import { InvitationOutcome } from "./InvitationOutcome";

import type { InvitationOutcomeProps } from "./InvitationOutcome";
import type { TFunction } from "i18next";

/** The OAuth providers the invitation activation flow offers. Mirrors `activation-oauth-routes.ts`. */
export type InvitationOAuthProvider = "google" | "microsoft" | "mock";

/** Translation keys for each provider button — resolved with `t()` at render time. */
const PROVIDER_LABEL_KEYS: Record<InvitationOAuthProvider, string> = {
  google: "onboarding.invite.continueWithGoogle",
  microsoft: "onboarding.invite.continueWithMicrosoft",
  mock: "onboarding.invite.continueWithMock",
};

/**
 * Builds the browser-redirect URL that starts the invitation OAuth flow for one provider
 * (`GET /api/auth/invitations/{token}/oauth/{provider}/start`, see `activation-oauth-routes.ts`).
 * A plain full-page navigation, not a fetch call — the provider round trip needs the whole browser,
 * and the API sets the session cookie on the redirect back, which no XHR/fetch response can do.
 *
 * `loginHint` is meaningful only for "mock" — it picks which email the mock IdP signs the token
 * for, which must be the invitation's own target email for activation to succeed (a mismatch is the
 * `REQUIRES_ADMIN_APPROVAL` branch, same as a real provider signing in as the wrong account).
 */
export function activationOAuthStartUrl(
  token: string,
  provider: InvitationOAuthProvider,
  loginHint?: string,
): string {
  const url = new URL(
    `${API_BASE_URL}/api/auth/invitations/${encodeURIComponent(token)}/oauth/${provider}/start`,
  );
  if (provider === "mock" && loginHint) url.searchParams.set("login_hint", loginHint);
  return url.toString();
}

/**
 * Actionable copy for each terminal invitation state (ST-180 AC: "all five failure states render
 * distinct actionable UI"). Keyed on the API's stable problem `code`
 * (`docs/security/invitation_verification_matrix.md`), never on prose, so a copy edit can never
 * silently detach from the branch it renders for.
 */
// A Map, not a plain object: `code` is a string the server put on the wire, and a Map sidesteps any
// prototype-property lookup concern that indexing a literal object with untrusted-shaped input would
// raise, with no loss of clarity. Values are translation-key prefixes under `onboarding.invite.*`
// (`.heading`, `.message`, and `.action` where an action exists), resolved at render time.
interface FailureCopy {
  keyPrefix: string;
  actionHref?: string;
}

const FAILURE_COPY = new Map<string, FailureCopy>([
  ["INVITATION_INVALID", { keyPrefix: "onboarding.invite.failures.invalid" }],
  ["EXPIRED", { keyPrefix: "onboarding.invite.failures.expired" }],
  ["REVOKED", { keyPrefix: "onboarding.invite.failures.revoked" }],
  ["CONSUMED", { keyPrefix: "onboarding.invite.failures.consumed", actionHref: "/auth/login" }],
  ["SCHOOL_SUSPENDED", { keyPrefix: "onboarding.invite.failures.schoolSuspended" }],
]);

const GENERIC_FAILURE: FailureCopy = { keyPrefix: "onboarding.invite.failures.generic" };

function outcomeProps(copy: FailureCopy, t: TFunction): Omit<InvitationOutcomeProps, "requestId"> {
  return {
    heading: t(`${copy.keyPrefix}.heading`),
    message: t(`${copy.keyPrefix}.message`),
    ...(copy.actionHref
      ? { action: { label: t(`${copy.keyPrefix}.action`), href: copy.actionHref } }
      : {}),
  };
}

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
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();

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
    return <InvitationOutcome {...outcomeProps(FAILURE_COPY.get("INVITATION_INVALID")!, t)} />;
  }

  if (isPending) {
    return <Loading />;
  }

  if (error || !data) {
    const copy = (code && FAILURE_COPY.get(code)) || GENERIC_FAILURE;
    const requestId = error instanceof ApiError ? error.request_id : null;
    return <InvitationOutcome {...outcomeProps(copy, t)} requestId={requestId} />;
  }

  return (
    <>
      <h1>{t("onboarding.invite.title", { schoolName: data.schoolName })}</h1>
      <p>{t("onboarding.invite.intro", { email: data.emailHint })}</p>
      <p>
        <a
          href={activationOAuthStartUrl(token, "google")}
          onClick={() => track(ACTIVATION_EVENTS.OAUTH_STARTED, { provider: "google" })}
        >
          {t(PROVIDER_LABEL_KEYS.google)}
        </a>
      </p>
      <p>
        <a
          href={activationOAuthStartUrl(token, "microsoft")}
          onClick={() => track(ACTIVATION_EVENTS.OAUTH_STARTED, { provider: "microsoft" })}
        >
          {t(PROVIDER_LABEL_KEYS.microsoft)}
        </a>
      </p>
      {SHOW_MOCK_LOGIN && (
        <p>
          <a
            href={activationOAuthStartUrl(
              token,
              "mock",
              searchParams.get("login_hint") ?? undefined,
            )}
            onClick={() => track(ACTIVATION_EVENTS.OAUTH_STARTED, { provider: "mock" })}
          >
            {t(PROVIDER_LABEL_KEYS.mock)}
          </a>
        </p>
      )}
    </>
  );
}
