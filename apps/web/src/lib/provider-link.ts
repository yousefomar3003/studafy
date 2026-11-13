import { api } from "./api";

import type { ApiClient, components } from "@studafy/api-client";

type LinkableProvider = components["schemas"]["LinkProviderStartRequest"]["provider"];

/**
 * Start linking a second OAuth provider to the signed-in account, then navigate to the provider.
 *
 * Use this rather than calling `POST /api/auth/providers/link/start` directly. The response sets the
 * OAuth browser-binding cookie (QA-20), and the provider callback rejects the link unless this
 * browser presents that cookie. The API is on a different origin from the web app, so the browser
 * stores a cookie from a fetch response only when the request is sent with `credentials: "include"`.
 * The shared bearer client omits credentials, so this call opts in for itself.
 */
export async function startProviderLink(
  provider: LinkableProvider,
  client: ApiClient = api,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const { data } = await client.POST("/api/auth/providers/link/start", {
    body: { provider },
    credentials: "include",
  });
  if (!data) {
    // Unreachable in practice: the problem+json middleware throws a typed ApiError on any non-2xx.
    throw new Error("Provider link start succeeded without a redirect URL");
  }
  navigate(data.redirect_url);
}
