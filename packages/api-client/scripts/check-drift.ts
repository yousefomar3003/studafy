import { stat } from "node:fs/promises";

import { GENERATED_TYPES_PATH } from "../openapi-typescript.config";

/**
 * Validates that the generated API client types exist and are non-empty.
 *
 * The generated types file is gitignored (see root .gitignore) so it never causes merge conflicts.
 * This check ensures generation succeeded and the output is usable. CI regenerates the file in an
 * earlier step and this runs as a smoke test.
 */
async function main(): Promise<void> {
  const outPath = process.env.CLIENT_TYPES_COMPARE ?? GENERATED_TYPES_PATH;

  try {
    const stats = await stat(outPath);
    if (stats.size === 0) {
      console.error(`ERROR: ${outPath} is empty. Run 'bun run client:generate'.`);
      process.exit(1);
    }
    console.log(`api-client types generated at ${outPath} (${stats.size} bytes).`);
  } catch {
    console.error(`ERROR: ${outPath} not found. Run 'bun run client:generate'.`);
    process.exit(1);
  }
}

await main();
