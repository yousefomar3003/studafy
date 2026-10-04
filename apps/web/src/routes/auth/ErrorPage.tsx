import { useSearchParams } from "react-router-dom";

import { StatusCard } from "../../components/StatusCard";
import { useTranslation } from "../../lib/i18n";

/**
 * OAuth sign-in error page (`/auth/error?code=…`).
 *
 * The API's browser-redirect OAuth callbacks bounce the browser here when an exchange fails
 * (`oauth/error-redirect.ts`), so a failed sign-in renders guidance on a real page instead of raw
 * problem+json at the API origin. The `code` query parameter is the API's stable problem code —
 * the provider's `code`/`state` are never echoed back and no token ever appears in a URL.
 *
 * Actionable copy for each documented auth failure state, keyed on the stable `code` (never on
 * prose), mirroring the invitation flow's `FAILURE_COPY`. Every state either offers a working
 * retry path or says honestly that retrying won't help. Retry goes back to `/auth/login`, where the
 * pending return-to saved by `RequireAuth` is still intact, so a successful re-sign-in completes
 * the original deep link.
 */
export default function ErrorPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const code = searchParams.get("code");

  const state = (code && STATE_COPY.get(code)) || GENERIC_FAILURE;

  return (
    <StatusCard
      heading={t(state.headingKey)}
      message={t(state.messageKey)}
      action={state.action && { label: t(state.action.labelKey), href: state.action.href }}
    />
  );
}

/** Copy is stored as translation keys (under `site.authError`) and resolved at render time. */
interface StateCopy {
  readonly headingKey: string;
  readonly messageKey: string;
  readonly action?: { readonly labelKey: string; readonly href: string };
}

const RETRY = { labelKey: "site.authError.retry", href: "/auth/login" } as const;
const BACK_TO_SIGN_IN = { labelKey: "site.authError.backToSignIn", href: "/auth/login" } as const;

function copy(state: string, action?: StateCopy["action"]): StateCopy {
  return {
    headingKey: `site.authError.${state}.heading`,
    messageKey: `site.authError.${state}.message`,
    action,
  };
}

const STATE_COPY = new Map<string, StateCopy>([
  ["OAUTH_STATE_INVALID", copy("stateInvalid", RETRY)],
  // The OAuth callbacks answer "Account not found. Contact your administrator." with AUTHZ_FORBIDDEN;
  // the returning-user login answers with NO_ACCOUNT. Both mean the same thing on this page.
  ["AUTHZ_FORBIDDEN", copy("noAccount", BACK_TO_SIGN_IN)],
  ["NO_ACCOUNT", copy("noAccount", BACK_TO_SIGN_IN)],
  ["OAUTH_EMAIL_NOT_VERIFIED", copy("emailNotVerified", RETRY)],
  ["OAUTH_PROVIDER_ERROR", copy("providerError", RETRY)],
  ["SCHOOL_SUSPENDED", copy("suspended")],
  ["TENANT_SUSPENDED", copy("suspended")],
  ["OAUTH_CANCELLED", copy("cancelled", RETRY)],
]);

const GENERIC_FAILURE = copy("generic", RETRY);
