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
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) {
      return;
    }

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const initial = initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container;
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
  }, [active, containerRef, initialFocusRef]);
}
