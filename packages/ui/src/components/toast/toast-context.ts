import { createContext, useContext } from "react";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  variant?: ToastVariant;
  title: string;
  description?: string;
  /** Milliseconds before the toast dismisses itself. `0` keeps it up until dismissed. */
  duration?: number;
}

export interface ToastContextValue {
  /** Queues a toast and returns its id, so a caller can dismiss it before the timer elapses. */
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const ToastContextProvider = ToastContext.Provider;

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be called inside <ToastProvider>.");
  }
  return context;
}
