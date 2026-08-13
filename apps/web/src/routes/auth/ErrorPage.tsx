import { useSearchParams } from "react-router-dom";

import { StatusCard } from "../../components/StatusCard";

import type { StatusCardProps } from "../../components/StatusCard";

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
  const [searchParams] = useSearchParams();
  const code = searchParams.get("code");

  const state = (code && STATE_COPY.get(code)) || GENERIC_FAILURE;

  return <StatusCard {...state} />;
}

const RETRY = { label: "Try again", href: "/auth/login" } as const;
const BACK_TO_SIGN_IN = { label: "Back to sign in", href: "/auth/login" } as const;

const STATE_COPY = new Map<string, StatusCardProps>([
  [
    "OAUTH_STATE_INVALID",
    {
      heading: "This sign-in link has expired",
      message: "The sign-in you started is no longer valid. Start again from the sign-in page.",
      action: RETRY,
    },
  ],
  // The OAuth callbacks answer "Account not found. Contact your administrator." with AUTHZ_FORBIDDEN;
  // the returning-user login answers with NO_ACCOUNT. Both mean the same thing on this page.
  [
    "AUTHZ_FORBIDDEN",
    {
      heading: "No account found for this sign-in",
      message:
        "The account you signed in with isn't linked to a Studafy account yet. If you used the wrong account, sign in again — otherwise ask your school administrator for an invitation.",
      action: BACK_TO_SIGN_IN,
    },
  ],
  [
    "NO_ACCOUNT",
    {
      heading: "No account found for this sign-in",
      message:
        "The account you signed in with isn't linked to a Studafy account yet. If you used the wrong account, sign in again — otherwise ask your school administrator for an invitation.",
      action: BACK_TO_SIGN_IN,
    },
  ],
  [
    "OAUTH_EMAIL_NOT_VERIFIED",
    {
      heading: "Your sign-in email isn't verified",
      message:
        "The provider hasn't verified the email on the account you signed in with. Verify it there, then try again.",
      action: RETRY,
    },
  ],
  [
    "OAUTH_PROVIDER_ERROR",
    {
      heading: "We couldn't complete your sign-in",
      message: "The sign-in service had a problem. Please try again in a moment.",
      action: RETRY,
    },
  ],
  [
    "SCHOOL_SUSPENDED",
    {
      heading: "Your school's account is suspended",
      message:
        "Sign-in is paused while your school's account is suspended. Contact your school administrator.",
    },
  ],
  [
    "TENANT_SUSPENDED",
    {
      heading: "Your school's account is suspended",
      message:
        "Sign-in is paused while your school's account is suspended. Contact your school administrator.",
    },
  ],
  [
    "OAUTH_CANCELLED",
    {
      heading: "Sign-in cancelled",
      message: "You cancelled the sign-in. Nothing changed — try again whenever you're ready.",
      action: RETRY,
    },
  ],
]);

const GENERIC_FAILURE: StatusCardProps = {
  heading: "We couldn't complete your sign-in",
  message: "Something went wrong on our end. Please try again in a moment.",
  action: RETRY,
};
