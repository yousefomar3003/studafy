import { isRouteErrorResponse, useRouteError } from "react-router-dom";

/**
 * Router `errorElement`: renders when a route throws (loader error, render error, or an
 * unmatched path via the router's default 404 response).
 */
export function RouteError() {
  const error = useRouteError();

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
