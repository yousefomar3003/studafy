import { Modal } from "@studafy/ui";
import { useEffect, useState } from "react";

import { useTranslation } from "../../lib/i18n";

import { SearchPalette } from "./SearchPalette";

import "./search-palette.css";

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

  return (
    <>
      <button type="button" className="global-search-trigger" onClick={() => setOpen(true)}>
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
        <kbd className="global-search-trigger__shortcut">{isMacPlatform() ? "⌘K" : "Ctrl+K"}</kbd>
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={t("globalSearch.title")}>
        <Modal.Body>{open ? <SearchPalette onClose={() => setOpen(false)} /> : null}</Modal.Body>
        <Modal.Footer>
          <span className="search-palette__hint">{t("globalSearch.keyboardHint")}</span>
        </Modal.Footer>
      </Modal>
    </>
  );
}
