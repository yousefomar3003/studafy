import { forwardRef, useCallback, useEffect, useId, useRef } from "react";

import { mergeRefs } from "../../internal/merge-refs";
import { Portal } from "../../internal/portal";
import { useFocusTrap } from "../../internal/use-focus-trap";

import type { HTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Names the dialog. Rendered as its heading unless `hideTitle` is set. */
  title: string;
  description?: string;
  children: ReactNode;
  /** Focused on open. Defaults to the first focusable element in the dialog's content (body or
   * footer), falling back to the header's close button only when there is no other candidate. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeOnOverlayClick?: boolean;
  closeOnEsc?: boolean;
}

const ModalRoot = forwardRef<HTMLDivElement, ModalProps>(function Modal(
  {
    open,
    onClose,
    title,
    description,
    children,
    initialFocusRef,
    closeOnOverlayClick = true,
    closeOnEsc = true,
  },
  ref,
) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descriptionId = `${baseId}-description`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const overlayMouseDown = useRef(false);

  useFocusTrap(dialogRef, open, initialFocusRef, headerRef);

  useEffect(() => {
    if (!open || !closeOnEsc) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeOnEsc, onClose, open]);

  // Lock the page behind the dialog so a scroll gesture cannot move the background.
  useEffect(() => {
    if (!open) {
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Only close when the gesture both starts and ends on the overlay: a drag that begins inside the
  // dialog and releases outside it must not dismiss.
  const onOverlayMouseDown = useCallback((event: ReactMouseEvent) => {
    overlayMouseDown.current = event.target === event.currentTarget;
  }, []);

  const onOverlayClick = useCallback(
    (event: ReactMouseEvent) => {
      if (closeOnOverlayClick && overlayMouseDown.current && event.target === event.currentTarget) {
        onClose();
      }
      overlayMouseDown.current = false;
    },
    [closeOnOverlayClick, onClose],
  );

  if (!open) {
    return null;
  }

  return (
    <Portal>
      <div className="sf-modal__overlay" onMouseDown={onOverlayMouseDown} onClick={onOverlayClick}>
        <div
          ref={mergeRefs(dialogRef, ref)}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          // Focusable so the trap has somewhere to park focus when the dialog has no controls.
          tabIndex={-1}
          className="sf-modal"
        >
          <div className="sf-modal__header" ref={headerRef}>
            <h2 className="sf-modal__title" id={titleId}>
              {title}
            </h2>
            <button
              type="button"
              className="sf-modal__close"
              aria-label="Close dialog"
              onClick={onClose}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {description ? (
            <p className="sf-modal__description" id={descriptionId}>
              {description}
            </p>
          ) : null}

          {children}
        </div>
      </div>
    </Portal>
  );
});

export type ModalSectionProps = Omit<HTMLAttributes<HTMLDivElement>, "className">;

export const ModalBody = forwardRef<HTMLDivElement, ModalSectionProps>(
  function ModalBody(props, ref) {
    return <div {...props} ref={ref} className="sf-modal__body" />;
  },
);

export const ModalFooter = forwardRef<HTMLDivElement, ModalSectionProps>(
  function ModalFooter(props, ref) {
    return <div {...props} ref={ref} className="sf-modal__footer" />;
  },
);

export const Modal = Object.assign(ModalRoot, {
  Body: ModalBody,
  Footer: ModalFooter,
});
