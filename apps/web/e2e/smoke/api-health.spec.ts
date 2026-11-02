import { expect, test } from "@playwright/test";

/**
 * Confirms the api/realtime services `staging-deploy.yml` just rolled are actually answering, from
 * outside the VPC, the same path a real client takes (through the ALB, not an internal target-group
 * check). `/healthz` (liveness) and `/readyz` (readiness) are the two-tier contract
 * `apps/api/src/health.ts` and `infra/deploy/README.md`'s "Probe mapping" already document; this
 * suite is what actually calls them post-deploy instead of only trusting ECS's own health check.
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
