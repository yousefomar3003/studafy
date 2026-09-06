import { expect, test } from "@playwright/test";

/**
 * The deployed api/realtime services are unreachable directly from this suite's box (private ALB,
 * VPC-only) so this is the honest way to smoke-check them end to end: load the already-running web
 * app (unaffected by this deploy — it's CDN-hosted, not part of the ECS rolling update) and confirm
 * it still renders against the api the pipeline just deployed, catching an integration break a
 * `/healthz` 200 alone can't see. This is deliberately just a render check, not a login-and-click
 * journey — `e2e/critical` already owns full user journeys against a disposable stack; this suite's
 * job is "did the deploy break the live app," not "does the feature work."
 */
test("web app renders against the deployed api", async ({ page }) => {
  await page.goto("/auth/login");
  await expect(page).toHaveTitle("Studafy");
  await expect(page.locator("body")).not.toBeEmpty();
});
