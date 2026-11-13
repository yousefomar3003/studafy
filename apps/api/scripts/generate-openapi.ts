import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildOpenApiDocument } from "../src/openapi/document";

/**
 * Regenerates apps/api/openapi.json from the routes createApp actually mounts (ST-060).
 *
 * Run via `bun run openapi:generate`. The output is gitignored (see root .gitignore) to eliminate
 * merge conflicts between branches. CI regenerates it at build time to ensure the toolchain works
 * and feeds it to downstream steps (client codegen, oasdiff).
 *
 * JSON only. Scalar, oasdiff, and `git diff` all read JSON natively.
 *
 * OPENAPI_OUT overrides the destination. The generation benchmark uses it to time this script
 * honestly without clobbering the regular output.
 */
async function main(): Promise<void> {
  const outPath = process.env.OPENAPI_OUT ?? path.join(import.meta.dirname, "..", "openapi.json");

  const document = {
    // JSON has no comments, so the do-not-edit warning rides along as a specification extension.
    // `x-` members are legal in OpenAPI 3.1 and are ignored by tooling that does not know them.
    "x-generated-by":
      "apps/api/scripts/generate-openapi.ts — do not hand-edit; CI checks for drift",
    ...(await buildOpenApiDocument()),
  };

  // Trailing newline: the file is committed, and Prettier reformats it in the same script.
  await writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`);
}

await main();
