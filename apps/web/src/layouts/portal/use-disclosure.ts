import { useCallback, useEffect, useRef, useState } from "react";

import type { RefObject } from "react";

export interface Disclosure {
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** Attach to the trigger button. Focus returns here on Escape. */
  triggerRef: RefObject<HTMLButtonElement>;
  /** Attach to the popover panel, so outside-click detection can exclude it. */
  panelRef: RefObject<HTMLDivElement>;
}

/**
 * Open/close state for a trigger-anchored popover (the notification bell, the user menu) —
 * factored out because both need the same three behaviors: Escape closes and returns focus to the
 * trigger, a pointerdown outside the trigger and panel closes, and neither listener exists at all
 * while the panel is closed.
 *
 * Deliberately lighter than `@studafy/ui`'s `Modal`: these are non-modal disclosures (the rest of
 * the page stays interactive and unhidden), so there is no focus trap and no scroll lock.
 */
export function useDisclosure(): Disclosure {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((current) => !current), []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return { open, toggle, close, triggerRef, panelRef };
}
