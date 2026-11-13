import { defineConfig, devices } from "@playwright/test";

import { WEB_BASE_URL, WEB_PORT, API_BASE_URL } from "./e2e/critical/support/ports";

/**
 * The critical-journeys E2E suite (ST-246), a second, deliberately separate config from
 * `playwright.config.ts`.
 *
 * Everything under `e2e/` (not `e2e/critical/`) stubs its own backend via `page.route()` and runs
 * against `vite dev` alone — see that config's own doc comment for why. This suite is the opposite
 * on purpose: it runs against a real Postgres + Redis + `apps/api` + `apps/workers` stack (a mock
 * OAuth identity provider and a fake Anthropic Messages API stand in for the two external
 * dependencies with no free test mode; a genuine ERPNext sandbox and Stripe's own real test mode
 * would be the other two if configured — see the ST-246 journey catalog for exactly which). Nothing
 * here is stubbed at the network layer. `global-setup.ts` brings that whole stack up before any spec
 * runs; `global-teardown.ts` tears it down after.
 *
 * The web app itself is the one piece Playwright's own `webServer` handles directly, matching
 * `playwright.a11y.config.ts`'s precedent: a production build (`vite build && vite preview`), not
 * the dev server, because this suite is meant to catch what actually ships. `VITE_ENABLE_MOCK_AUTH`
 * is what makes the "Continue with Mock" button render on that otherwise-production build — see
 * `lib/config.ts`'s `SHOW_MOCK_LOGIN`.
 */
export default defineConfig({
  testDir: "./e2e/critical",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // A retried test that then passes is exactly what this suite's <2% flake-rate acceptance
  // criterion is measured against (see the CI workflow's flake-rate report step) — retries must stay
  // on in CI for that number to mean anything, and a locally-reproducible failure should show up
  // without retries while iterating.
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "test-results/critical-results.json" }]]
    : "list",
  globalSetup: "./e2e/critical/support/global-setup.ts",
  globalTeardown: "./e2e/critical/support/global-teardown.ts",
  use: {
    baseURL: WEB_BASE_URL,
    // Every journey gets a trace and a video, not just a retry — these are the CI nightly's primary
    // debugging artifact (ST-246 AC: "failure artifacts (trace/video) retained") and a flake that
    // passes on retry is exactly the run whose first attempt you most want a trace of.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun run build && bun run preview -- --port ${WEB_PORT} --strictPort`,
    url: WEB_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_API_BASE_URL: API_BASE_URL,
      VITE_ENABLE_MOCK_AUTH: "true",
    },
  },
});
