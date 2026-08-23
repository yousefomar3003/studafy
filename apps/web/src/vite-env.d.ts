/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the Studafy API. Defaults to http://localhost:3000 when unset. */
  readonly VITE_API_BASE_URL?: string;
  /** Origin of the realtime gateway. Defaults to ws://localhost:3001 when unset. */
  readonly VITE_REALTIME_BASE_URL?: string;
  /**
   * Contact address shown on the marketing site's About/Contact page. No built-in default — an
   * invented address would silently misdirect real inquiries, so the page falls back to a visible
   * "not configured" notice instead of a fabricated mailto.
   */
  readonly VITE_MARKETING_CONTACT_EMAIL?: string;
  /**
   * Cloudflare Turnstile site key for the school registration form's bot-protection widget.
   * Defaults to Cloudflare's publicly documented always-passing test key when unset, matching the
   * API's own dev bypass (registration/captcha.ts skips verification when TURNSTILE_SECRET_KEY is
   * unset) — see lib/config.ts.
   */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /**
   * Sentry DSN for the web app's error monitoring (`lib/monitoring`). Unset in local dev and in the
   * `containers.yml` validation build — monitoring stays disabled rather than failing without one.
   */
  readonly VITE_SENTRY_DSN?: string;
  /** Sentry environment tag. Defaults to the Vite build mode when unset. */
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  /**
   * Deploy identifier baked in at Docker build time (`infra/docker/web.Dockerfile`), normally the
   * git commit SHA used as the release's immutable image tag. Defaults to "unknown".
   */
  readonly VITE_RELEASE_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
