/**
 * Mobile-only accounts on the web. Students, parents, teachers and attendance officers use Studafy
 * through the mobile app only (`MOBILE_ONLY_ROLES` in `@studafy/constants`), so a web session is
 * neither issued nor refreshed for a user holding nothing but those roles. Enforced in
 * `issueTokenPair` and `rotateRefreshToken`, which every sign-in and refresh path goes through —
 * the web's own redirect is UX on top of this, not the boundary.
 */
import { ERROR_CODES, isMobileOnly } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import { AUTH_CHANNELS } from "./channels";

import type { AuthChannel } from "./channels";

export function isWebSessionRefused(channel: AuthChannel, roles: readonly string[]): boolean {
  return channel === AUTH_CHANNELS.WEB && isMobileOnly(roles);
}

/** 403, not 401: signing in again on the web cannot fix it; the mobile app can. */
export function mobileOnlyWebException(): CodedHttpException {
  return new CodedHttpException(
    403,
    ERROR_CODES.WEB_ACCESS_MOBILE_ONLY,
    "This account uses the Studafy mobile app. Sign in there instead.",
  );
}
