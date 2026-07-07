import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from "react";

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * App-level error boundary shell. Catches render-time errors thrown outside the router (e.g. in
 * providers) and shows an accessible fallback. Route-level errors are handled by
 * {@link RouteError} via the router's `errorElement`.
 */
export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled application error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div role="alert">
          <h1>Something went wrong</h1>
          <p>Please reload the page. If the problem persists, contact support.</p>
        </div>
      );
    }

    return this.props.children;
  }
}
