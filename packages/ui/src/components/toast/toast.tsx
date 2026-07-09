import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { cx } from "../../internal/cx";
import { Portal } from "../../internal/portal";

import { ToastContextProvider, useToast } from "./toast-context";

import type { ToastOptions, ToastVariant } from "./toast-context";
import type { ReactNode } from "react";

interface ToastRecord extends ToastOptions {
  id: string;
  variant: ToastVariant;
}

/**
 * Errors and warnings interrupt; successes and informational messages wait for a pause. This is
 * the only difference in how the two groups are announced.
 */
const isAssertive = (variant: ToastVariant) => variant === "error" || variant === "warning";

interface ToastItemProps {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const assertive = isAssertive(toast.variant);

  return (
    <div
      // `role` carries the live-region semantics rather than an `aria-live` wrapper: the toast is
      // inserted into an already-mounted viewport, which is what screen readers need in order to
      // notice it. The viewport is a plain <div> and not a list, because list semantics would
      // conflict with these roles and tell the user nothing useful.
      role={assertive ? "alert" : "status"}
      aria-atomic="true"
      className={cx("sf-toast", `sf-toast--${toast.variant}`)}
    >
      <div className="sf-toast__content">
        <p className="sf-toast__title">{toast.title}</p>
        {toast.description ? <p className="sf-toast__description">{toast.description}</p> : null}
      </div>

      <button
        type="button"
        className="sf-toast__dismiss"
        aria-label={`Dismiss ${toast.title}`}
        onClick={() => onDismiss(toast.id)}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path
            d="M3 3l6 6M9 3l-6 6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

export interface ToastProviderProps {
  children: ReactNode;
  /** Default lifetime for toasts that do not set their own `duration`. `0` disables auto-dismiss. */
  duration?: number;
}

/**
 * Owns the toast queue and renders the portalled viewport. Mount once, at the application root.
 * Toasts are fired imperatively through `useToast()`.
 */
export function ToastProvider({ children, duration = 5000 }: ToastProviderProps) {
  const baseId = useId();
  const nextIndex = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [toasts, setToasts] = useState<ToastRecord[]>([]);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      nextIndex.current += 1;
      const id = `${baseId}-toast-${nextIndex.current}`;
      const lifetime = options.duration ?? duration;

      setToasts((current) => [...current, { ...options, id, variant: options.variant ?? "info" }]);

      if (lifetime > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), lifetime),
        );
      }

      return id;
    },
    [baseId, dismiss, duration],
  );

  // A provider can unmount with toasts still pending; their timers would otherwise outlive it.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContextProvider value={value}>
      {children}

      <Portal>
        <div className="sf-toast-viewport">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
      </Portal>
    </ToastContextProvider>
  );
}

export { useToast };
export type { ToastContextValue, ToastOptions, ToastVariant } from "./toast-context";
