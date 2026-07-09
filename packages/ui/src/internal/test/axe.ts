import { run } from "axe-core";

/**
 * Accessibility assertion used by every component test.
 *
 * `color-contrast` and `color-contrast-enhanced` are disabled: they need a real renderer to sample
 * painted pixels, and happy-dom has no layout or cascade. Contrast is not skipped — it is enforced
 * at the source of truth by theme.contrast.test.ts, which checks every semantic text/background
 * pair in both themes against WCAG AA. That is a stronger guarantee than sampling whatever a story
 * happened to render.
 *
 * What axe does catch here is exactly the class of defect these components can introduce: invalid
 * roles, `aria-*` attributes pointing at ids that do not exist, controls with no accessible name,
 * and malformed listbox / tablist / radiogroup structures.
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
