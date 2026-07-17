import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GENERATED_TYPES_PATH } from "../openapi-typescript.config";

import { generateClientTypes } from "./build-api-client";

/** Repository root — two levels above this package (packages/api-client → studafy/). */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PRETTIER_CONFIG = path.join(REPO_ROOT, "prettier.config.js");

/**
 * Fails the build when the committed generated types no longer match the OpenAPI document they are
 * generated from — i.e. someone edited src/generated-types.ts by hand, or changed the spec without
 * regenerating the client.
 *
 * Regenerates into a throwaway temp file (never touching the committed artifact or the git tree) and
 * compares it against the committed file with `git diff --no-index`, which prints a real unified diff
 * as the change vector and is the same tool the OpenAPI drift gate uses. Exit 1 on any difference.
 *
 * CLIENT_TYPES_COMPARE overrides the comparison target. The drift-simulation test points it at a
 * deliberately-corrupted copy to prove this runner flags a manual modification and exits 1, without
 * dirtying the real file.
 */
async function main(): Promise<void> {
  const compareTarget = process.env.CLIENT_TYPES_COMPARE ?? GENERATED_TYPES_PATH;

  const scratch = await mkdtemp(path.join(tmpdir(), "studafy-api-client-drift-"));
  const freshPath = path.join(scratch, "generated-types.ts");

  try {
    await generateClientTypes(freshPath);

    // Reproduce the `generate` script's pipeline exactly: it formats the committed file with
    // Prettier, so the fresh copy must be formatted with the same repo config before comparison, or
    // formatting-only differences would masquerade as drift. The config is passed explicitly because
    // the scratch file lives outside the repo where Prettier could not otherwise discover it.
    const format = Bun.spawnSync(
      ["bunx", "prettier", "--config", PRETTIER_CONFIG, "--write", freshPath],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    if (format.exitCode !== 0) {
      console.error("Failed to format regenerated types for comparison:");
      console.error(format.stderr.toString());
      process.exitCode = 1;
      return;
    }

    const diff = Bun.spawnSync(
      ["git", "--no-pager", "diff", "--no-index", "--", compareTarget, freshPath],
      { stdout: "pipe", stderr: "pipe" },
    );

    // `git diff --no-index` exits 0 when the files are identical and 1 when they differ.
    if (diff.exitCode === 0) {
      console.log(`api-client types are in sync with ${path.basename(compareTarget)}.`);
      return;
    }

    console.error("## api-client type drift\n");
    console.error(
      `${path.relative(process.cwd(), compareTarget)} does not match the types generated from apps/api/openapi.json.`,
    );
    console.error("Run `bun run client:generate` and commit the result.\n");
    console.error(diff.stdout.toString());
    process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
