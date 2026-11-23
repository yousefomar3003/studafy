import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createProgram,
  getPreEmitDiagnostics,
  ModuleResolutionKind,
  ScriptTarget,
} from "typescript";

/**
 * The control arm of client-build-benchmark.test.ts: the pipeline in scripts/verify-pipeline.ts
 * with the codegen taken out. It pays the same fixed costs -- a `bun run` spawn, loading the
 * TypeScript compiler, type-checking against lib.es2022 with the same options, and a Bun.build --
 * over a one-line module, so its time measures how fast this host is, not anything the API client
 * owns. The benchmark scales its budget by it.
 */

const scratch = process.env.CLIENT_PIPELINE_OUT;
if (!scratch) {
  throw new Error("CLIENT_PIPELINE_OUT must name a scratch directory");
}
await mkdir(scratch, { recursive: true });
const entry = path.join(scratch, "control.ts");
await writeFile(entry, "export const control: { ok: true } = { ok: true };\n");

const program = createProgram([entry], {
  strict: true,
  target: ScriptTarget.ES2022,
  moduleResolution: ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
  lib: ["lib.es2022.d.ts"],
  types: [],
});
if (getPreEmitDiagnostics(program).length > 0) {
  throw new Error("control module failed TypeScript verification");
}

const build = await Bun.build({
  entrypoints: [entry],
  outdir: path.join(scratch, "control-dist"),
  external: ["*"],
});
if (!build.success) {
  throw new AggregateError(build.logs, "control bundle failed");
}
