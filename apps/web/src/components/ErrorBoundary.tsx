import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from "react";

import { useTranslation } from "../lib/i18n";
import { captureException } from "../lib/monitoring";

/** The fallback is a function component so it can read translations through the hook; the
 * i18next instance is initialized at import time, so this works even when a provider crashed. */
function ErrorFallback() {
  const { t } = useTranslation();

  return (
    <div role="alert">
      <h1>{t("site.errorBoundary.heading")}</h1>
      <p>{t("site.errorBoundary.message")}</p>
    </div>
  );
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * App-level error boundary shell. Catches render-time errors thrown outside the router (e.g. in
 * providers) and shows an accessible fallback. Route-level errors are handled by
 * {@link RouteError} via the router's `errorElement`. Both report to Sentry through
 * `captureException` (`lib/monitoring`) — this is one of the two catch points the "thrown test
 * error appears in Sentry" acceptance criterion exercises.
 */
export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled application error:", error, info.componentStack);
    captureException(error, { componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorFallback />;
    }

    return this.props.children;
  }
}
