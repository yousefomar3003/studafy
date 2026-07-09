// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { semanticColor } from "./theme";

/**
 * tokens.css is hand-authored to mirror theme.ts (see the header comment in both files).
 * This test is the guardrail against drift: it parses the `:root` (light) and
 * `:root[data-theme="dark"]` blocks out of the CSS and asserts every semantic color variable
 * resolves to the same value theme.ts exports.
 */

function extractBlock(css: string, blockStart: string): Record<string, string> {
  const startIndex = css.indexOf(blockStart);
  if (startIndex === -1) {
    throw new Error(`Could not find block "${blockStart}" in tokens.css`);
  }
  const openBraceIndex = css.indexOf("{", startIndex);
  const closeBraceIndex = css.indexOf("}", openBraceIndex);
  const body = css.slice(openBraceIndex + 1, closeBraceIndex);

  const declarations: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    declarations[match[1]] = match[2].trim();
  }
  return declarations;
}

function resolveVar(value: string, declarations: Record<string, string>): string {
  const match = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (!match) {
    return value;
  }
  const referenced = declarations[match[1]];
  if (referenced === undefined) {
    throw new Error(`tokens.css references undefined variable --${match[1]}`);
  }
  return resolveVar(referenced, declarations);
}

const semanticVarNames = {
  background: "color-background",
  surface: "color-surface",
  foreground: "color-foreground",
  mutedForeground: "color-muted-foreground",
  border: "color-border",
  accent: "color-accent",
  accentForeground: "color-accent-foreground",
  accentSubtleBg: "color-accent-subtle-bg",
  accentSubtleForeground: "color-accent-subtle-foreground",
  success: "color-success",
  successForeground: "color-success-foreground",
  successSubtleBg: "color-success-subtle-bg",
  successSubtleForeground: "color-success-subtle-foreground",
  danger: "color-danger",
  dangerForeground: "color-danger-foreground",
  dangerSubtleBg: "color-danger-subtle-bg",
  dangerSubtleForeground: "color-danger-subtle-foreground",
  warning: "color-warning",
  warningForeground: "color-warning-foreground",
  warningSubtleBg: "color-warning-subtle-bg",
  warningSubtleForeground: "color-warning-subtle-foreground",
} as const satisfies Record<keyof (typeof semanticColor)["light"], string>;

describe("tokens.css matches theme.ts", () => {
  test("every semantic color variable resolves to the theme.ts value", async () => {
    const css = await Bun.file(new URL("./tokens.css", import.meta.url)).text();

    const lightDeclarations = extractBlock(css, ":root {");
    // `:root[data-theme="dark"]` only overrides semantic aliases — primitive scale variables
    // (e.g. --color-neutral-950) still cascade from the plain `:root` block, so merge over it
    // to mirror how a browser would actually resolve `var(...)` here.
    const darkDeclarations = {
      ...lightDeclarations,
      ...extractBlock(css, ':root[data-theme="dark"]'),
    };

    for (const [key, varName] of Object.entries(semanticVarNames)) {
      const expectedLight = semanticColor.light[key as keyof typeof semanticColor.light];
      const expectedDark = semanticColor.dark[key as keyof typeof semanticColor.dark];

      // eslint-disable-next-line security/detect-object-injection -- `varName` is drawn only from the fixed semanticVarNames map, never external input
      const actualLight = resolveVar(lightDeclarations[varName], lightDeclarations).toLowerCase();
      // eslint-disable-next-line security/detect-object-injection -- `varName` is drawn only from the fixed semanticVarNames map, never external input
      const actualDark = resolveVar(darkDeclarations[varName], darkDeclarations).toLowerCase();

      expect(actualLight).toBe(expectedLight.toLowerCase());
      expect(actualDark).toBe(expectedDark.toLowerCase());
    }
  });
});
