import { defineConfig, devices } from "@playwright/test";

/**
 * Post-deploy smoke suite (ST-255's staging deploy pipeline). A third, deliberately separate
 * config from `playwright.config.ts` and `playwright.critical.config.ts`: those two stand up their
 * own backend (stubbed via `page.route()`, or a full local stack via `global-setup.ts`) and their
 * own `webServer`. This one does the opposite — it has no `webServer` at all and never touches
 * localhost, because its entire point is asserting the real thing the staging pipeline just
 * deployed answers, over the network, from the outside: `SMOKE_WEB_URL` (the CDN-hosted web app,
 * unaffected by this deploy) still renders and can reach `SMOKE_API_URL` (the api/realtime
 * services this deploy just rolled), the same live user journey a manual click-through would
 * exercise. Fails fast if either env var is missing rather than silently defaulting to localhost
 * and passing against nothing.
 */
function requireEnv(name: "SMOKE_WEB_URL", value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} must be set to run the smoke suite against a real deployment`);
  }
  return value;
}

export default defineConfig({
  testDir: "./e2e/smoke",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: requireEnv("SMOKE_WEB_URL", process.env.SMOKE_WEB_URL),
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
