/**
 * Fetches a realtime handshake ticket (QA-14): `GET /api/realtime/ticket` with the session's access
 * token. The gateway accepts only these tickets, never the access token itself, so the access token
 * stays out of WebSocket URLs. A ticket opens one socket within 30 seconds, so one is fetched for
 * every connection attempt. See apps/realtime/docs/protocol.md#handshake-ticket.
 *
 * Resolves `null` when there is no session (no access token, or the API answers 401/403), which the
 * client reports as `unauthorized`. Throws on anything else (network failure, 5xx), which the client
 * treats as transient and retries with backoff.
 */
export async function fetchRealtimeTicket({
  apiBaseUrl,
  getAccessToken,
  fetchFn = globalThis.fetch.bind(globalThis),
}: {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchFn?: typeof globalThis.fetch;
}): Promise<string | null> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return null;
  }
  const response = await fetchFn(new URL("/api/realtime/ticket", apiBaseUrl), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    credentials: "omit",
  });
  if (response.status === 401 || response.status === 403) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`realtime ticket request failed with ${response.status}`);
  }
  const body = (await response.json()) as { ticket?: unknown };
  if (typeof body.ticket !== "string" || body.ticket.length === 0) {
    throw new Error("realtime ticket response carried no ticket");
  }
  return body.ticket;
}
