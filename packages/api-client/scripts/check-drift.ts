import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GENERATED_TYPES_PATH } from "../openapi-typescript.config";

import { generateClientTypes } from "./build-api-client";

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
    // The generated file is the raw, deterministic openapi-typescript output (LF newlines, a pure
    // function of the spec + pinned tool version), committed as-is and Prettier-ignored. So the fresh
    // copy is compared to the committed one byte for byte, with no formatting step to diverge across
    // platforms.
    await generateClientTypes(freshPath);

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
