import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildOpenApiDocument } from "../src/openapi/document";

/**
 * Regenerates apps/api/openapi.json from the routes createApp actually mounts (ST-060).
 *
 * Run via `bun run openapi:generate`. Do not hand-edit the output: CI regenerates it and fails the
 * build if the working tree comes back dirty, so a manual edit is reverted and reported as drift.
 *
 * The document is committed rather than built only in CI so that a contract change appears in the
 * pull-request diff and gets reviewed like any other code, and so oasdiff has a base revision to
 * classify breaking changes against.
 *
 * JSON only. Scalar, oasdiff, and `git diff` all read JSON natively, and a second serialization
 * would be a second artifact to keep from drifting.
 *
 * OPENAPI_OUT overrides the destination. The generation benchmark uses it to time this script
 * honestly without clobbering the committed artifact.
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
