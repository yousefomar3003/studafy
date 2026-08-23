import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * A second, narrower config for the two specs that assert on focus *destination*
 * (`keyboard-accessibility-walkthrough.spec.ts`'s dialog-trap checks) or on painted color
 * (`accessibility-audit.spec.ts`'s axe color-contrast pass): both need the production bundle, not
 * `playwright.config.ts`'s dev server.
 *
 * React 18 `<StrictMode>` (see `main.tsx`) makes Vite dev diverge from production in a way that
 * matters specifically for focus: opening `ApprovalDiffModal` under `vite dev` reproducibly leaves
 * `document.activeElement` on `<body>` instead of the dialog's first focusable element, even though
 * `useFocusTrap` calls `.focus()` on the right element and that call visibly takes — verified by
 * instrumenting the hook, and by the fact this same journey lands focus correctly, every time,
 * against `vite build && vite preview`. StrictMode's extra dev-only render pass is the documented
 * cause of exactly this class of transient-DOM-node symptom; it is intentionally stripped from
 * production, which is what real users — keyboard or otherwise — actually get. Everything else in
 * `e2e/` stays on `playwright.config.ts`'s dev server, matching this repo's existing specs.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["keyboard-accessibility-walkthrough.spec.ts", "accessibility-audit.spec.ts"],
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
    command: "bun run build && bun run preview -- --port 4173 --strictPort",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
