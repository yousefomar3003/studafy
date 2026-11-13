import type { Page } from "@playwright/test";

/**
 * Replaces Cloudflare's Turnstile script with a fake that renders nothing and calls back with a
 * token immediately.
 *
 * The one deliberate exception to this suite's "no stubs, real backend" rule (see
 * playwright.critical.config.ts's doc comment) — everything else here is genuinely live, but
 * Turnstile's entire purpose is detecting and blocking exactly this kind of automated traffic, and
 * the sibling stubbed suite already confirmed the real widget does not reliably resolve headless
 * within 30s (`e2e/registration.spec.ts`'s own doc comment). A nightly gate with a <2% flake budget
 * cannot absorb a third party whose job is to say no to it.
 */
export async function stubTurnstile(page: Page): Promise<void> {
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `window.turnstile = {
        render: (container, options) => {
          options.callback("fake-e2e-turnstile-token");
          return "fake-widget-id";
        },
        reset: () => {},
        remove: () => {},
      };`,
    }),
  );
}
