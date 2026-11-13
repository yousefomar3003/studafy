import { expect, test } from "@playwright/test";

/**
 * Confirms a deployment's api/realtime services are actually answering, from outside, the same
 * path a real client takes (SMOKE_API_URL, not the platform's internal health check). `/healthz`
 * (liveness) and `/readyz` (readiness) are the two-tier contract `apps/api/src/health.ts`
 * documents; this suite is what actually calls them after a deploy instead of only trusting the
 * platform's own check.
 */
const API_BASE_URL = process.env.SMOKE_API_URL;
if (!API_BASE_URL) {
  throw new Error("SMOKE_API_URL must be set to run the smoke suite against a real deployment");
}

for (const path of ["/healthz", "/readyz"]) {
  test(`api ${path} responds ok`, async ({ request }) => {
    const response = await request.get(`${API_BASE_URL}${path}`);
    expect(response.status(), `${path} status`).toBe(200);
  });
}
