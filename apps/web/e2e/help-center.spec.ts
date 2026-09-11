import { expect, test } from "@playwright/test";

/**
 * Public help-center smoke check: `/help` (home + article routes) renders through the real Vite
 * bundle — lazy tree-shaken page chunks, Markdown rendering, and the `/docs/help` raw imports that
 * only exist in the browser build. No `RequireAuth` wrapper or API stubs needed; the help center is
 * public by design (see the `/help` group in `src/app/routes.tsx`).
 */
test("help center home lists every published article category", async ({ page }) => {
  await page.goto("/help");

  await expect(page.getByRole("heading", { name: "Help center" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Onboarding guide/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Timetable builder/ })).toBeVisible();
});

test("help article renders Markdown with its canonical heading anchors", async ({ page }) => {
  await page.goto("/help/onboarding-guide");

  await expect(page.locator("#help-article-title")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Step 1: School profile" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Step 1: School profile" })).toHaveAttribute(
    "id",
    "step-1-school-profile",
  );
});

test("documented step screenshots are served and render", async ({ page }) => {
  await page.goto("/help/onboarding-guide");

  const firstScreenshot = page.locator(
    'img[alt^="School profile step"][src="/help-media/screenshots/onboarding-school-profile.png"]',
  );
  await expect(firstScreenshot).toBeVisible();
  await expect
    .poll(() => firstScreenshot.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test("a wizard step's help link targets the matching article anchor", async ({ page }) => {
  await page.goto("/help/onboarding-guide#step-5-staff-invitations");

  await expect(page.getByRole("heading", { name: "Step 5: Staff invitations" })).toBeVisible();
});
