import { run } from "axe-core";

/**
 * Accessibility assertion for page-level tests. Mirrors `@studafy/ui`'s
 * `internal/test/axe.ts` — same rationale, same disabled-rules list — so a route test and a
 * component test read the same violation report.
 *
 * `color-contrast` and `color-contrast-enhanced` are disabled: they need a real renderer to sample
 * painted pixels, and happy-dom has no layout or cascade. This app has no per-page CSS to sample
 * anyway — every page in `src/routes` renders semantic HTML with only the shared `global.css` reset,
 * so there is nothing here color-contrast would be checking.
 */
export async function expectNoA11yViolations(container: Element): Promise<void> {
  const results = await run(container as HTMLElement, {
    resultTypes: ["violations"],
    rules: {
      "color-contrast": { enabled: false },
      "color-contrast-enhanced": { enabled: false },
    },
  });

  if (results.violations.length === 0) {
    return;
  }

  const report = results.violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => `      ${node.target.join(" ")}`).join("\n");
      return `  ${violation.id}: ${violation.help}\n${targets}`;
    })
    .join("\n");

  throw new Error(
    `Expected no accessibility violations, found ${results.violations.length}:\n${report}`,
  );
}
