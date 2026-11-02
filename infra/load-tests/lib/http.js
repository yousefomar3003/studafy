// Small request helpers shared by every scenario. Kept deliberately thin — k6's `http` module
// already does the real work; this just standardizes the two things every call site here needs:
// a bearer-authenticated JSON header set, and a request-level `endpoint` tag so
// config/thresholds.js can target one `http_req_duration{endpoint:...}` series per route instead of
// one blended series for the whole scenario.

/** Standard JSON + bearer headers for one authenticated user. */
export function authHeaders(accessToken, extra) {
  return Object.assign(
    {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    extra || {},
  );
}

/**
 * Params for an authenticated JSON request, tagged for per-endpoint thresholds and Grafana/Cloud
 * dashboards alike. `name` also collapses k6's default per-URL grouping (which would otherwise
 * create one series per interpolated UUID) down to one series per logical endpoint.
 */
export function taggedParams(accessToken, endpoint, extraHeaders) {
  return {
    headers: authHeaders(accessToken, extraHeaders),
    tags: { endpoint },
  };
}

/** Picks one element deterministically from an array using the running VU/iteration counters. */
export function pickByVu(list, vu, iter) {
  if (list.length === 0) {
    throw new Error("pickByVu: list is empty — check the data file this scenario was given");
  }
  const index = (vu - 1 + iter) % list.length;
  return list[index];
}
