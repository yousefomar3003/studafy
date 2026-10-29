import { Modal } from "@studafy/ui";
import { lazy, Suspense, useEffect, useState } from "react";

import { useTranslation } from "../../lib/i18n";

import "./search-palette.css";

/**
 * The palette (with the destinations registry, ranking, record links and result mapping behind it)
 * is its own chunk. `PortalLayout` sits in the entry bundle, so a static import here would ship all
 * of it to every page — the marketing home and sign-in included, whose Lighthouse budgets
 * (`lighthouserc.json`) it pushed over. It loads on first open, or earlier when the browser is idle.
 */
const loadSearchPalette = () => import("./SearchPalette");
const SearchPalette = lazy(() =>
  loadSearchPalette().then((module) => ({ default: module.SearchPalette })),
);

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // `navigator.platform` is deprecated but still the simplest signal for "which modifier key
  // labels itself Cmd" -- this only decides display text, never behavior (both Cmd and Ctrl work
  // as the shortcut either way, see the keydown handler below).
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/**
 * Header-mounted global search: an icon+label trigger plus the Cmd/Ctrl+K shortcut, both opening
 * the same command palette (`SearchPalette`). Mirrors `NotificationBell`/`UserMenu` in owning its
 * own open state, but the shortcut listener is unconditional (not gated on `open` the way
 * `useDisclosure`'s Escape/outside-click listeners are) since it has to fire while the palette is
 * closed in order to open it.
 *
 * No permission gate, same posture as the API route itself (`requireAuth` only -- see
 * `apps/api/src/modules/search/routes.ts`): every authenticated portal session can search, and
 * which record types actually come back is scoped server-side per caller.
 */
export function GlobalSearchTrigger() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) return;
      event.preventDefault();
      setOpen((current) => !current);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Fetch the palette's chunk once the portal page has settled, so the first Ctrl+K opens at once.
  useEffect(() => {
    const prefetch = () => void loadSearchPalette().catch(() => undefined);
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(prefetch, 2000);
    return () => window.clearTimeout(handle);
  }, []);

  return (
    <>
      <button
        type="button"
        className="global-search-trigger"
        onClick={() => setOpen(true)}
        onPointerEnter={() => void loadSearchPalette().catch(() => undefined)}
      >
        <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M13.5 13.5 17 17"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <span>{t("globalSearch.triggerLabel")}</span>
        <kbd className="global-search-trigger__shortcut" dir="ltr">
          {isMacPlatform() ? "⌘K" : "Ctrl+K"}
        </kbd>
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={t("globalSearch.title")}>
        <Modal.Body>
          {open ? (
            <Suspense
              fallback={
                <p role="status" className="search-palette__empty">
                  {t("globalSearch.loading")}
                </p>
              }
            >
              <SearchPalette onClose={() => setOpen(false)} />
            </Suspense>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <span className="search-palette__hint">{t("globalSearch.keyboardHint")}</span>
        </Modal.Footer>
      </Modal>
    </>
  );
}
