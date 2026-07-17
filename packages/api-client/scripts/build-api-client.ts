import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import openapiTS, { astToString } from "openapi-typescript";

import {
  GENERATED_BANNER,
  GENERATED_TYPES_PATH,
  OPENAPI_SPEC_PATH,
  OPENAPI_TS_OPTIONS,
} from "../openapi-typescript.config";

/**
 * Regenerates packages/api-client/src/generated-types.ts from apps/api/openapi.json (ST-060).
 *
 * Run via `bun run --cwd packages/api-client generate` (or root `bun run client:generate`). Do not
 * hand-edit the output: CI regenerates it and fails the build if the working tree comes back dirty,
 * so a manual edit is reverted and reported as drift.
 *
 * The types are committed rather than built only in CI so that a contract change appears in the
 * pull-request diff and gets reviewed like any other code.
 *
 * CLIENT_TYPES_OUT overrides the destination. The build benchmark and the drift-simulation test use
 * it to time/compare this script honestly without clobbering the committed artifact.
 */
export async function generateClientTypes(outPath: string): Promise<string> {
  // Parse the committed document and hand openapi-typescript the object directly, rather than a URL
  // it would fetch. Codegen is then a pure function of a file already reviewed and drift-guarded.
  const spec = JSON.parse(await readFile(OPENAPI_SPEC_PATH, "utf8")) as Parameters<
    typeof openapiTS
  >[0];

  const ast = await openapiTS(spec, OPENAPI_TS_OPTIONS);
  const contents = `${GENERATED_BANNER}\n${astToString(ast)}`;

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, contents);
  return contents;
}

async function main(): Promise<void> {
  const outPath = process.env.CLIENT_TYPES_OUT ?? GENERATED_TYPES_PATH;
  await generateClientTypes(outPath);
}

// Only write when run directly (`bun run scripts/build-api-client.ts`). Importing this module for its
// `generateClientTypes` export — as check-drift.ts does — must not overwrite the committed artifact.
if (import.meta.main) {
  await main();
}
