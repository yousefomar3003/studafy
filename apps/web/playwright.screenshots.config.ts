import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Narrow config for `help-screenshots.spec.ts` only: captures the onboarding wizard steps into
 * `apps/web/public/help-media/screenshots/` so the help articles can reference current images. The
 * spec drives the same Vite dev server and API stubs as the default suite — no Postgres or
 * `apps/api` — and is excluded from `playwright.config.ts` so the default `e2e` run never
 * regenerates (and dirties) the repo's screenshots unprompted. Run it deliberately after a UI
 * change that the docs picture. See `/docs/help/README.md`'s "Screenshots" section.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["help-screenshots.spec.ts"],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 1600 } },
    },
  ],
  webServer: {
    command: "bun run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
  },
});
