/**
 * Framework-agnostic locale store: the same "plain module + React wiring in context.tsx" split as
 * `lib/auth/session-store.ts`. Owns exactly one thing — which locale is active — and persists it to
 * `localStorage` so a choice survives reloads and new tabs for that browser profile (there is no
 * per-user server-side preference to sync against; see the i18n contribution guide for why that's a
 * deliberate scope line for this ticket, not an oversight).
 *
 * The initial locale is resolved once, in this order: a persisted choice, then the browser's
 * `navigator.language`, then `DEFAULT_LOCALE`. Every later change is explicit (the locale switcher)
 * and always wins over both.
 */

import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from "./config";

const STORAGE_KEY = "studafy:locale";

export interface LocaleStoreOptions {
  /** Test seam. Defaults to `window.localStorage` (absent under SSR/non-browser test runners). */
  readonly storage?: Storage;
  /** Test seam. Defaults to `navigator.language`. */
  readonly detectLocale?: () => string | undefined;
}

export interface LocaleStore {
  getLocale(): Locale;
  setLocale(locale: Locale): void;
  subscribe(listener: () => void): () => void;
}

function readStoredLocale(storage: Storage | undefined): Locale | null {
  const raw = storage?.getItem(STORAGE_KEY);
  return raw !== null && raw !== undefined && isSupportedLocale(raw) ? raw : null;
}

function detectBrowserLocale(detect: (() => string | undefined) | undefined): Locale | null {
  const tag = detect?.();
  const primary = tag?.split("-")[0];
  return primary && isSupportedLocale(primary) ? primary : null;
}

export function createLocaleStore(options: LocaleStoreOptions = {}): LocaleStore {
  const storage =
    options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  const detect =
    options.detectLocale ??
    (typeof navigator !== "undefined" ? () => navigator.language : undefined);

  let locale: Locale = readStoredLocale(storage) ?? detectBrowserLocale(detect) ?? DEFAULT_LOCALE;

  const listeners = new Set<() => void>();

  return {
    getLocale: () => locale,
    setLocale(next) {
      if (next === locale) {
        return;
      }
      locale = next;
      try {
        storage?.setItem(STORAGE_KEY, next);
      } catch {
        // Private-browsing/quota rejections: the choice still applies for the rest of this
        // session, it just won't survive a reload. Not worth surfacing to the user.
      }
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The app-wide locale store. `context.tsx` is the only thing that should read this directly. */
export const localeStore = createLocaleStore();
