import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { build } from "./build";
import { guides } from "./content";
import { OPENAPI_SPEC_PATH } from "./paths";

/**
 * Exercises the real, hand-authored guide content in apps/docs-api/src/content against the real,
 * generated apps/api/openapi.json — this is the "examples validated against spec in CI" acceptance
 * criterion actually running, not merely asserted in a comment.
 *
 * Skipped when openapi.json has not been generated yet (a bare `bun test` outside the CI/turbo
 * pipeline that runs `bun run openapi:generate` first) — see the file this reads, apps/api's own
 * generate step, and validate.test.ts for the spec-independent unit coverage that always runs.
 */
const specExists = existsSync(OPENAPI_SPEC_PATH);

describe.skipIf(!specExists)("build (against the real generated spec)", () => {
  test("every guide's examples validate, and every expected file is written", async () => {
    const distDir = await mkdtemp(path.join(tmpdir(), "docs-api-build-"));
    try {
      await build(distDir);

      const expected = [
        "index.html",
        "operations.html",
        "openapi.json",
        ...guides.map((guide) => `${guide.slug}.html`),
      ];
      for (const file of expected) {
        expect(existsSync(path.join(distDir, file))).toBe(true);
      }

      const errorsPage = await readFile(path.join(distDir, "errors.html"), "utf8");
      expect(errorsPage).toContain("RESOURCE_NOT_FOUND");
    } finally {
      await rm(distDir, { recursive: true, force: true });
    }
  });
});
