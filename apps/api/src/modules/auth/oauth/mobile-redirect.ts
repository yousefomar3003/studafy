/**
 * The native app's deep link, `studafy://auth/callback` — built from the scheme/host/path constants
 * in `apps/mobile/lib/src/core/auth/oauth_browser.dart`'s `OAuthBrowser`, which listens on it.
 *
 * Never sent to a provider: the providers' web clients refuse custom-scheme redirect URIs, so every
 * native-app sign-in returns to the server's own HTTPS callback first. That callback then sends the
 * browser here with a one-time handoff code (or `error`), which brings the user back to the app —
 * see mobile-handoff.ts.
 */
export const MOBILE_OAUTH_REDIRECT_URI = "studafy://auth/callback";

/** The Android application id per deployment tier (`apps/mobile/android/app/build.gradle.kts`). */
const ANDROID_PACKAGES = {
  production: "com.studafy.studafy_mobile",
  staging: "com.studafy.studafy_mobile.staging",
  development: "com.studafy.studafy_mobile.dev",
  test: "com.studafy.studafy_mobile.dev",
} as const;

export type AppTier = keyof typeof ANDROID_PACKAGES;

/**
 * Apple platforms. Everything else is treated as Android, including an Android tablet whose Chrome
 * asks for desktop sites (it then sends a desktop Linux user agent).
 */
const APPLE_USER_AGENT = /\b(iPhone|iPad|iPod|Macintosh|Mac OS X)\b/u;

/**
 * Where the browser goes to hand a sign-in result back to the app.
 *
 * On Android any installed app can declare the `studafy://` scheme, and a link to it opens
 * whichever claims it (or asks the user to pick). A malicious app could then start its own sign-in,
 * let the user finish it at Google or Microsoft, and catch the redirect carrying the handoff code
 * together with the state and nonce it was itself given. So on Android the redirect is an
 * `intent://` URL naming our package: the browser delivers it to that one application id, which no
 * other app on the device can hold, or sends the user to the Play listing if it is missing. The app
 * still receives a plain `studafy://auth/callback?...` link, so it needs no change.
 *
 * On iOS the sign-in runs in an `ASWebAuthenticationSession`, which returns the callback to the app
 * that opened the session and to no other, so the plain scheme is already bound to the caller.
 *
 * The choice keys on the browser's own user agent at the callback — the victim's browser, which an
 * attacker who started the flow does not control — never on anything the app sent to `/mobile-start`.
 */
export function mobileAppRedirectUrl(
  params: Record<string, string>,
  userAgent: string | undefined,
  tier: AppTier,
): string {
  const target = new URL(MOBILE_OAUTH_REDIRECT_URI);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  if (userAgent !== undefined && APPLE_USER_AGENT.test(userAgent)) return target.toString();

  // eslint-disable-next-line security/detect-object-injection -- `tier` is a closed union
  const androidPackage = ANDROID_PACKAGES[tier];
  // intent://<host><path>?<query>#Intent;scheme=<scheme>;package=<id>;end
  return `intent://${target.host}${target.pathname}${target.search}#Intent;scheme=${target.protocol.replace(/:$/u, "")};package=${androidPackage};end`;
}
