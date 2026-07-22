import { createMockIdp } from "./mock-idp";

import type { MockIdpOptions } from "./mock-idp";

export type { MockIdpOptions } from "./mock-idp";

/**
 * True when the mock IdP may be mounted. Disabled in staging and production
 * builds so the mock is unreachable outside dev/test environments.
 */
export function isMockIdpEnabled(
  env: { NODE_ENV?: string; APP_ENV?: string } = process.env,
): boolean {
  return env.NODE_ENV !== "production" && env.APP_ENV !== "production";
}

/**
 * Create the mock IdP if the environment allows it, or return null.
 *
 * @example
 * ```typescript
 * const idp = createMockIdpIfEnabled({ issuer: "http://localhost:4000" });
 * if (idp) app.route("/idp", idp);
 * ```
 */
export function createMockIdpIfEnabled(
  options: MockIdpOptions,
  env: { NODE_ENV?: string; APP_ENV?: string } = process.env,
) {
  return isMockIdpEnabled(env) ? createMockIdp(options) : null;
}
