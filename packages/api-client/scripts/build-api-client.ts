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
 * Run via `bun run --cwd packages/api-client generate` (or root `bun run client:generate`). The
 * output is gitignored (see root .gitignore) to eliminate merge conflicts between branches. CI
 * regenerates it at build time to keep it in sync with the spec.
 *
 * CLIENT_TYPES_OUT overrides the destination. The build benchmark uses it to time this script
 * honestly without clobbering the regular output.
 */
export async function generateClientTypes(outPath: string): Promise<string> {
  // Parse the committed document and hand openapi-typescript the object directly, rather than a URL
  // it would fetch. Codegen is then a pure function of a file already reviewed and drift-guarded.
  const spec = JSON.parse(await readFile(OPENAPI_SPEC_PATH, "utf8")) as Parameters<
    typeof openapiTS
  >[0];

  const ast = await openapiTS(spec, OPENAPI_TS_OPTIONS);
  const contents = normalize(`${GENERATED_BANNER}\n${astToString(ast)}`);

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, contents);
  return contents;
}

/**
 * Makes the emitted bytes identical on every OS, so the committed artifact and a CI regeneration
 * compare equal regardless of where each ran. Normalizes newlines to LF, strips trailing whitespace
 * (the TypeScript printer can leave it on blank JSDoc lines, and it is not otherwise visible in a
 * diff), and ends the file with exactly one newline.
 */
function normalize(source: string): string {
  return `${source
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "")}\n`;
}

async function main(): Promise<void> {
  const outPath = process.env.CLIENT_TYPES_OUT ?? GENERATED_TYPES_PATH;
  await generateClientTypes(outPath);
}

// Only write when run directly (`bun run scripts/build-api-client.ts`). Importing this module for its
// `generateClientTypes` export — as check-drift.ts does — must not overwrite the file.
if (import.meta.main) {
  await main();
}
