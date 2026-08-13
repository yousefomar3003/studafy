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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
