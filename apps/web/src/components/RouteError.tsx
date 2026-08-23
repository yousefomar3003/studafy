import { useEffect } from "react";
import { isRouteErrorResponse, useRouteError } from "react-router-dom";

import { captureException } from "../lib/monitoring";

/**
 * Router `errorElement`: renders when a route throws (loader error, render error, or an
 * unmatched path via the router's default 404 response). Reports non-404 route errors to Sentry
 * — a route response like a plain 404 is expected navigation, not a bug, so it stays out of
 * monitoring the same way `ErrorBoundary`'s sibling catch point only reports real exceptions.
 */
export function RouteError() {
  const error = useRouteError();

  useEffect(() => {
    if (!isRouteErrorResponse(error)) {
      captureException(error);
    }
  }, [error]);

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "An unexpected error occurred.";

  return (
    <div role="alert">
      <h1>Something went wrong</h1>
      <p>{message}</p>
    </div>
  );
}
