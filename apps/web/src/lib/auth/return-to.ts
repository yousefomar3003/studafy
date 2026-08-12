/**
 * Return-to routing for the OAuth login round trip.
 *
 * A full-page OAuth redirect (web -> provider -> web) destroys in-memory state, so the intended
 * destination must survive the trip somewhere else. `sessionStorage` is the canonical carrier: it
 * lives for the tab, is per-origin, and — critically — holds only a *path*, never token material.
 * The tokens themselves stay in memory (see `session-store.ts`); this module is the sole storage
 * touchpoint in the auth layer and the code audit test (`token-storage.test.ts`) pins that down.
 *
 * Only internal paths are accepted (`/` but not `//`), so a crafted return-to cannot turn the
 * post-login redirect into an open redirect to an attacker's origin.
 */

const RETURN_TO_KEY = "studafy.auth.return-to";

function readStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    // No storage available (privacy mode / non-browser host): degrade to no return-to.
    return null;
  }
}

/** True for a same-origin path: starts with `/` and is not protocol-relative (`//host`). */
export function isInternalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

/** Remember the route to restore after login. Ignores non-internal paths. */
export function setReturnTo(path: string): void {
  if (!isInternalPath(path)) {
    return;
  }
  readStorage()?.setItem(RETURN_TO_KEY, path);
}

/** The pending return-to path, or null when none was stored (or it failed the internal check). */
export function getReturnTo(): string | null {
  const value = readStorage()?.getItem(RETURN_TO_KEY);
  return value && isInternalPath(value) ? value : null;
}

/** Drop the pending return-to. */
export function clearReturnTo(): void {
  readStorage()?.removeItem(RETURN_TO_KEY);
}

/** Read and drop in one call — the callback's redirect consumes it. */
export function consumeReturnTo(): string | null {
  const value = getReturnTo();
  clearReturnTo();
  return value;
}
