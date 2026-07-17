// Measures the ST-061 acceptance target: the codegen compiler runs, synthesizes types for every
// route, runs TypeScript verification, and exports the package distribution in under 3 seconds.
//
// This is an ABSOLUTE wall-clock budget, defensible for the same reasons the ST-060 generation
// benchmark is (see apps/api/tests/benchmark/openapi-generate-benchmark.test.ts): there is no
// "same pipeline without codegen" arm to subtract, because producing the typed distribution is the
// whole program. It reports a MEDIAN of several cold runs, and the whole pipeline is measured as a
// single `bun run` spawn — process spawn and module import dominate, and those are exactly where a
// regression would come from (a heavier spec, a fatter type graph, a new heavy import).
//
// The pipeline it times (scripts/verify-pipeline.ts) generates the types, type-checks them with the
// TypeScript compiler API, and exports the bundle. A full-package `tsc` was deliberately not used to
// measure the type step: tsc's floor is loading every ambient @types package (~2s of pure startup),
// which would consume the entire budget measuring the host rather than the codegen. The generated
// module is structural and self-contained, so it is verified against the standard library alone —
// honest and fast. Deep, full-package semantic type-checking runs unbudgeted in the `check-types`
// task and its own CI step.
//
// Gated in-file and in CI so `bun test` does not spawn these subprocesses on every local run.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect, test } from "bun:test";

const benchmarkTest = test.skipIf(process.env.CLIENT_BUILD_BENCHMARK !== "1");

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 5;
const TARGET_MS = 3_000;

/** Routes the synthesized types must contain, so a pipeline that emitted nothing cannot pass. */
const EXPECTED_PATHS = ['"/healthz"', '"/readyz"', '"/erpnext/webhooks"'];

const PACKAGE_ROOT = path.join(import.meta.dir, "..", "..");
const PIPELINE_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "verify-pipeline.ts");

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function report(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  console.log(
    `${label}: min=${sorted[0]!.toFixed(1)}ms median=${median.toFixed(1)}ms ` +
      `p95=${percentile(sorted, 0.95).toFixed(1)}ms max=${sorted[sorted.length - 1]!.toFixed(1)}ms`,
  );
  return median;
}

/**
 * Runs the full acceptance pipeline as one `bun run` spawn — codegen → TypeScript verification →
 * bundle export — writing only into `scratch`, so the committed artifact and the git tree are never
 * disturbed.
 */
async function runPipelineSpawn(scratch: string): Promise<number> {
  const startedAt = performance.now();
  const proc = Bun.spawn(["bun", "run", PIPELINE_SCRIPT], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, CLIENT_PIPELINE_OUT: scratch },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const elapsed = performance.now() - startedAt;

  if (exitCode !== 0) {
    throw new Error(
      `verify-pipeline.ts exited ${exitCode}: ${await new Response(proc.stderr).text()}`,
    );
  }
  return elapsed;
}

benchmarkTest(
  `codegen → typecheck → bundle completes in under ${TARGET_MS}ms`,
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "studafy-client-build-"));
    try {
      for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
        await runPipelineSpawn(scratch);
      }

      const samples: number[] = [];
      for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
        samples.push(await runPipelineSpawn(scratch));
      }

      // Proof the pipeline did the work: a run that emitted nothing would otherwise post a great time.
      const synthesized = await readFile(path.join(scratch, "generated-types.ts"), "utf8");
      for (const route of EXPECTED_PATHS) {
        expect(synthesized).toContain(route);
      }

      const median = report("api-client build", samples);
      console.log(`api-client build: ${median.toFixed(1)}ms (target < ${TARGET_MS}ms)`);
      expect(median).toBeLessThan(TARGET_MS);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  120_000,
);
