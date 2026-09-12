const STORAGE_KEY = "studafy.global-search.recent.v1";
const MAX_RECENT_SEARCHES = 5;

/**
 * Recent search terms for the command palette. `localStorage`-backed only -- there is no
 * server-side search-history endpoint, and the ticket calls for local-only history, so this never
 * makes a network request. Versioned key so a future shape change discards old, incompatible
 * stored data on read instead of crashing on it, same convention as
 * `routes/onboarding-setup/progress.ts`.
 */

function readStore(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((term): term is string => typeof term === "string");
  } catch {
    return [];
  }
}

function writeStore(terms: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(terms));
  } catch {
    // Storage unavailable (private browsing, quota exceeded) -- recent searches degrade to
    // session-only rather than breaking the palette.
  }
}

export function loadRecentSearches(): string[] {
  return readStore().slice(0, MAX_RECENT_SEARCHES);
}

/** Adds `term` to the front of the list, de-duplicating case-insensitively, and returns the new
 * list. Ignores blank input. */
export function addRecentSearch(term: string): string[] {
  const trimmed = term.trim();
  if (!trimmed) return loadRecentSearches();

  const withoutDuplicate = readStore().filter(
    (existing) => existing.toLowerCase() !== trimmed.toLowerCase(),
  );
  const next = [trimmed, ...withoutDuplicate].slice(0, MAX_RECENT_SEARCHES);
  writeStore(next);
  return next;
}

export function clearRecentSearches(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore -- nothing to clear if storage never worked
  }
}
