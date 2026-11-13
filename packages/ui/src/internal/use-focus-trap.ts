import { useEffect } from "react";

import { getFocusableElements } from "./focusable";

import type { RefObject } from "react";

/**
 * Confines Tab/Shift+Tab to `containerRef` while `active`, and restores focus to whatever was
 * focused beforehand on deactivation.
 *
 * Implemented in JS rather than with the `inert` attribute: `inert` is unimplemented in happy-dom,
 * so a trap relying on it could not be tested, and browser support for programmatic focus
 * containment is what a dialog actually needs.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
  /**
   * Chrome to skip when picking the *default* initial-focus target — `Modal` passes its header
   * here, so the default lands on the first focusable thing the dialog is actually about (the
   * ARIA APG-recommended behavior for a dialog's initial focus), not its close button, which is
   * first in DOM order in every `@studafy/ui` dialog. Still fully reachable by Tab either way; this
   * only changes what gets focused on open.
   *
   * Before this parameter existed, the close button silently beat a field's own `autoFocus` every
   * time: React applies `autoFocus` during the commit's mutation phase, before `Portal`'s own
   * `useLayoutEffect` has attached its container to `document.body`, so that `.focus()` call lands
   * on a still-disconnected node and is a no-op — `autoFocus` inside a portal never actually focuses
   * anything, in any React version. Eight modal forms across the app set it on their first field on
   * exactly that (reasonable, everywhere-else-correct) assumption.
   */
  defaultFocusSkipRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) {
      return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const skip = defaultFocusSkipRef?.current;
    const focusable = getFocusableElements(container);
    // Prefer content over chrome, but a dialog with no focusable content at all (no ref target,
    // just a close button) must still get the close button, not fall through to the container.
    const defaultTarget = focusable.find((element) => !skip?.contains(element)) ?? focusable[0];
    const initial = initialFocusRef?.current ?? defaultTarget ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") {
        return;
      }

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        // Nothing to move to; keep focus on the dialog itself rather than escaping to the page.
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === first || activeElement === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [active, containerRef, initialFocusRef, defaultFocusSkipRef]);
}
