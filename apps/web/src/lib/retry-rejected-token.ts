/**
 * A `fetch` that recovers from an access token the API rejects before it expires.
 *
 * The session store rotates tokens on a timer ahead of expiry, which covers the normal lifetime. It
 * cannot know when a still-unexpired token stops verifying — the API restarted or deployed and now
 * signs with a new key, so every open tab's token answers 401 `AUTH_TOKEN_INVALID` until the page
 * is reloaded. On exactly that answer this refreshes the session once (single-flight in the store,
 * so a burst of failing requests shares one rotation) and replays the request with the new token.
 * Any other 401, or a rotation that yields no new token, returns the original response untouched.
 */
export interface RejectedTokenSession {
  /** Rotate the session and resolve its outcome (`SessionStore.restore`). */
  restore(): Promise<unknown>;
  getToken(): Promise<string | null>;
}

/** Plain fetch signature; `typeof fetch` also carries runtime extras (Bun's `preconnect`). */
type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const REJECTED_TOKEN_CODE = "AUTH_TOKEN_INVALID";

async function isRejectedToken(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return (
    body !== null &&
    typeof body === "object" &&
    (body as { code?: unknown }).code === REJECTED_TOKEN_CODE
  );
}

export function retryOnRejectedToken(
  session: RejectedTokenSession,
  baseFetch: FetchFn = (input, init) => globalThis.fetch(input, init),
): typeof globalThis.fetch {
  const retrying: FetchFn = async (input, init) => {
    const request = new Request(input, init);
    const replay = request.clone();
    const response = await baseFetch(request);
    if (!(await isRejectedToken(response))) return response;

    const sentToken = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? null;
    await session.restore();
    const freshToken = await session.getToken();
    if (!freshToken || freshToken === sentToken) return response;

    replay.headers.set("Authorization", `Bearer ${freshToken}`);
    return baseFetch(replay);
  };
  // The api-client only ever calls it as a function; nothing reads fetch's runtime extras.
  return retrying as typeof globalThis.fetch;
}
