// Target environments, mirroring docs/runbooks/environment-matrix.md's "Edge / DNS" table — this
// is the one other place those hostnames are written down, so this file only ever repeats them, it
// never invents its own.
//
// Honesty note (see ../README.md): `staging-api.studafy.com` is what the Terraform/deploy code in
// this repo is *written* to produce. As of this suite's authoring, staging has never been applied
// against a real AWS account from this repo's own environment, so nothing here has ever resolved.
// TARGET_ENV lets a real run point at whatever actually exists when someone runs this for real.

export const ENVIRONMENTS = {
  local: { baseUrl: "http://localhost:3000" },
  dev: { baseUrl: "https://dev-api.studafy.com" },
  staging: { baseUrl: "https://staging-api.studafy.com" },
};

/**
 * Resolve the base URL for this run.
 *
 * `BASE_URL` wins outright when set — the escape hatch for a port-forwarded ECS task, a
 * developer's own tunnel, or an environment this table doesn't know about yet. Otherwise
 * `TARGET_ENV` (default `local`) picks a row above.
 */
export function resolveBaseUrl() {
  const explicit = __ENV.BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const targetEnv = __ENV.TARGET_ENV || "local";
  const entry = ENVIRONMENTS[targetEnv];
  if (!entry) {
    throw new Error(
      `Unknown TARGET_ENV "${targetEnv}". Known: ${Object.keys(ENVIRONMENTS).join(", ")}, ` +
        "or set BASE_URL directly.",
    );
  }
  return entry.baseUrl;
}
