/**
 * A boolean "this browser had a live session" hint, so public pages can show the signed-in header
 * without probing the refresh endpoint for every anonymous visitor (the store restores lazily, and
 * `/api/auth/refresh` is tightly rate-limited). Only a presence flag is stored — never a token,
 * user id, or anything derived from the session — and `localStorage` is used so the hint survives a
 * reload or a new tab, matching the HttpOnly refresh cookie's lifetime closely enough. A stale hint
 * costs one refresh call, after which the store's `unauthenticated`/`expired` outcome clears it.
 */
import type { SessionStatus } from "./session-store";

const SIGNED_IN_HINT_KEY = "studafy.auth.signed-in";

function readStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    // No storage available (privacy mode / non-browser host): public pages simply show "Sign in".
    return null;
  }
}

export function wasSignedIn(): boolean {
  try {
    return readStorage()?.getItem(SIGNED_IN_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Mirrors a session status change into the hint. `restoring` is transitional and left alone. */
export function syncSignedInHint(status: SessionStatus): void {
  try {
    const storage = readStorage();
    if (status === "authenticated") storage?.setItem(SIGNED_IN_HINT_KEY, "1");
    else if (status === "unauthenticated" || status === "expired")
      storage?.removeItem(SIGNED_IN_HINT_KEY);
  } catch {
    // Quota/private-mode rejections only cost the hint, never the session itself.
  }
}
