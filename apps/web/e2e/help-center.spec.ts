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
  await expect(page.getByRole("link", { name: /^Timetable\b/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Add a student\b/ })).toBeVisible();
});

test("help article renders Markdown with its canonical heading anchors", async ({ page }) => {
  await page.goto("/help/onboarding-guide");

  await expect(page.locator("#help-article-title")).toBeVisible();
  // The article's own `# Onboarding guide` line is not rendered a second time under the page title.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Step 1: School profile" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Step 1: School profile" })).toHaveAttribute(
    "id",
    "step-1-school-profile",
  );
});

test("Do it now is not offered to a signed-out reader", async ({ page }) => {
  await page.goto("/help/add-student");

  await expect(page.locator("#help-article-title")).toHaveText("Add a student");
  await expect(page.getByRole("link", { name: "Do it now" })).toHaveCount(0);
});

test("documented step screenshots are served and render", async ({ page }) => {
  await page.goto("/help/onboarding-guide");

  const firstScreenshot = page.locator(
    'img[alt^="School profile step"][src="/help-media/screenshots/onboarding-school-profile.webp"]',
  );
  await expect(firstScreenshot).toBeVisible();
  await expect
    .poll(() => firstScreenshot.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
});

test("a wizard step's help link targets the matching article anchor", async ({ page }) => {
  await page.goto("/help/onboarding-guide#step-5-student-import");

  await expect(page.getByRole("heading", { name: "Step 5: Student import" })).toBeVisible();
});
