/**
 * QA-053: every base image is pinned by digest, and nginx is on a supported line.
 *
 * `FROM oven/bun:1.3.14-alpine` or `clamav/clamav:1.4` resolves to whatever the registry serves
 * today: builds were not reproducible and a moved tag silently changed production. Each FROM now
 * names the image by tag (for people) and @sha256 digest (for the build); Dependabot proposes
 * digest bumps.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "../../..");
const dockerDir = join(root, "infra/docker");
const dockerfiles = readdirSync(dockerDir).filter((name) => name.endsWith(".Dockerfile"));

/** FROM lines with their ARG defaults substituted, skipping references to earlier stages. */
function baseImages(name: string): string[] {
  const text = readFileSync(join(dockerDir, name), "utf8");
  const args = new Map<string, string>();
  for (const match of text.matchAll(/^ARG\s+([A-Z_]+)=(\S+)/gm)) args.set(match[1]!, match[2]!);
  const stages = new Set([...text.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]!));
  return [...text.matchAll(/^FROM\s+(\S+)/gm)]
    .map((m) =>
      m[1]!.replace(/\$\{([A-Z_]+)\}/g, (_, key: string) => args.get(key) ?? `\${${key}}`),
    )
    .filter((image) => !stages.has(image));
}

describe("container base images (QA-053)", () => {
  for (const name of dockerfiles) {
    test(`${name} pins every base image by digest`, () => {
      for (const image of baseImages(name)) {
        expect(`${image}`).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
    });
  }

  test("the web image runs a supported nginx line (1.28+)", () => {
    const image = baseImages("web.Dockerfile").find((ref) => ref.startsWith("nginx:"))!;
    const [major, minor] = image.slice("nginx:".length).split(/[.-]/).map(Number);
    expect(major! > 1 || minor! >= 28).toBe(true);
  });

  test("Dependabot proposes Docker base image updates", () => {
    const config = readFileSync(join(root, ".github/dependabot.yml"), "utf8");
    expect(config).toMatch(/package-ecosystem:\s*docker/);
  });
});
