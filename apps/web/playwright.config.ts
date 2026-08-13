import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * The first Playwright config in this repo — no e2e framework existed before ST-184. Scoped to
 * `apps/web/e2e`; nothing else in the monorepo depends on it. Specs stub every API call via
 * `page.route()` rather than running against a live backend, so `webServer` only needs the Vite
 * dev server, not Postgres or a running `apps/api` — see `e2e/registration.spec.ts` for why.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
  },
});
