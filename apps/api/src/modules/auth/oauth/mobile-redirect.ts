/**
 * Fixed redirect URI every mobile OAuth code exchange must present to the provider's token
 * endpoint.
 *
 * The mobile app authorizes with this custom-scheme URI — `studafy://auth/callback`, built from the
 * scheme/host/path constants in `apps/mobile/lib/src/core/auth/oauth_browser.dart`'s
 * `OAuthBrowser.redirectUri` — because it captures the provider's redirect itself via a deep link
 * instead of bouncing through this API the way the browser-redirect flows do. Google and Microsoft
 * both require the token exchange's `redirect_uri` to exactly match the one used to obtain the
 * authorization code (RFC 6749 §4.1.3), so every mobile exchange must send this literal rather than
 * `GoogleOAuthConfig.redirectUri` / `MicrosoftOAuthConfig.redirectUri` — those are the server's own
 * HTTPS callback path, correct for the web login and web activation flows, wrong for mobile.
 */
export const MOBILE_OAUTH_REDIRECT_URI = "studafy://auth/callback";
