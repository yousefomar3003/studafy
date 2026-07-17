import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createProgram,
  formatDiagnostics,
  getPreEmitDiagnostics,
  ModuleResolutionKind,
  ScriptTarget,
} from "typescript";

import { generateClientTypes } from "./build-api-client";

/**
 * The ST-061 acceptance pipeline, end to end in a single process: the codegen compiler runs,
 * synthesizes types for every route, runs TypeScript verification on them, and exports the package
 * distribution bundle. Run directly (`bun run scripts/verify-pipeline.ts`) or via `bun run verify`;
 * the build benchmark spawns it to time the whole thing against the sub-3-second budget.
 *
 * Everything is written to a scratch directory, so the committed artifact and the git tree are never
 * touched.
 */

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

export async function runPipeline(scratch: string): Promise<string> {
  await mkdir(scratch, { recursive: true });
  const typesPath = path.join(scratch, "generated-types.ts");

  // 1. Codegen — synthesize typed fetch definitions for every route from the committed spec.
  await generateClientTypes(typesPath);

  // 2. TypeScript verification — the synthesized types must compile with zero diagnostics. The
  //    generated file is self-contained (no imports), so it is checked against the standard library
  //    alone with `types: []` — ambient @types packages (which dominate a cold tsc) are irrelevant to
  //    a structural type-only module, and excluding them is what keeps this verification honest and
  //    fast. Full-package semantic type-checking runs unbudgeted in the `check-types` task.
  const program = createProgram([typesPath], {
    strict: true,
    target: ScriptTarget.ES2022,
    moduleResolution: ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts"],
    types: [],
  });
  const diagnostics = getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    const formatted = formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => PACKAGE_ROOT,
      getNewLine: () => "\n",
    });
    throw new Error(`Generated types failed TypeScript verification:\n${formatted}`);
  }

  // 3. Export the distribution bundle (workspace/npm deps left external, as the real build does).
  const build = await Bun.build({
    entrypoints: [path.join(PACKAGE_ROOT, "src", "index.ts")],
    outdir: path.join(scratch, "dist"),
    external: ["*"],
  });
  if (!build.success) {
    throw new AggregateError(build.logs, "Bundle export failed");
  }

  return typesPath;
}

async function main(): Promise<void> {
  const scratch =
    process.env.CLIENT_PIPELINE_OUT ??
    path.join(os.tmpdir(), `studafy-client-pipeline-${process.pid}`);
  await runPipeline(scratch);
  console.log(`api-client pipeline ok → ${scratch}`);
}

if (import.meta.main) {
  await main();
}
