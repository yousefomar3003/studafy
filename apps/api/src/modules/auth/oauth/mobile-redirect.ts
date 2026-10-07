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
