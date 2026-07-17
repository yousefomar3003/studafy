// Measures the ST-060 acceptance target: the build script parses every endpoint, runs its type
// assertions, emits the schema artifact, and completes in under 2 seconds.
//
// This is an ABSOLUTE wall-clock budget, and it is the only one in this directory. The two
// benchmarks beside it assert a delta for a documented reason -- an absolute budget on a shared CI
// runner measures the host as much as the code, and the NFR-05 probe had to be widened twice
// (500ms -> 600ms -> 1000ms) because it asserted a number within ~2x of its real cost. That reasoning
// still holds. It simply does not apply here: there is no "the same script without OpenAPI
// generation" arm to subtract, because generating the document is the entire program. The ticket
// promises a wall clock, so a wall clock is what this measures.
//
// What makes it defensible where NFR-05 was not:
//   - it reports a MEDIAN of several spawns, not one shot;
//   - the margin is several times the budget rather than ~2x;
//   - it measures the whole `bun run` -- process spawn and module import dominate, and those are
//     exactly where a regression would come from (someone adding a heavy import to the graph).
//
// Timing buildOpenApiDocument() in-process instead would report single-digit milliseconds against a
// 2000ms budget: true, meaningless, and blind to the regression that matters.
//
// If this flaps on CI, widen TARGET_MS or split spawn cost from generation cost. Do not lower
// MEASURED_ITERATIONS -- the median is what makes the number trustworthy.
//
// Gated in-file as well as in CI: `bun test` in this app globs every directory, and without the
// skipIf this would spawn subprocesses on every local unit-test invocation.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect, test } from "bun:test";

const benchmarkTest = test.skipIf(process.env.OPENAPI_BENCHMARK !== "1");

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 5;
const TARGET_MS = 2_000;

/** Routes the document must contain, so a script that wrote nothing cannot pass by doing nothing. */
const EXPECTED_PATHS = ["/healthz", "/readyz", "/erpnext/webhooks"];

const SCRIPT = path.join(import.meta.dir, "..", "..", "scripts", "generate-openapi.ts");
const CWD = path.join(import.meta.dir, "..", "..");

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
 * Run the real script exactly as `bun run openapi:generate` does, writing to a scratch path.
 *
 * OPENAPI_OUT is why the committed artifact is never touched: a benchmark that rewrote the file it
 * measures would dirty the working tree on every run and trip the CI drift gate it exists beside.
 */
async function generate(outPath: string): Promise<number> {
  const startedAt = performance.now();
  const proc = Bun.spawn(["bun", "run", SCRIPT], {
    cwd: CWD,
    env: { ...process.env, OPENAPI_OUT: outPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const elapsed = performance.now() - startedAt;

  if (exitCode !== 0) {
    throw new Error(
      `generate-openapi.ts exited ${exitCode}: ${await new Response(proc.stderr).text()}`,
    );
  }

  return elapsed;
}

benchmarkTest(
  `generate-openapi.ts emits the document in under ${TARGET_MS}ms`,
  async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "studafy-openapi-"));
    const outPath = path.join(scratch, "openapi.json");

    try {
      // One spawn to warm the filesystem cache for Bun's module graph. Unlike the in-process
      // benchmarks there is no JIT to warm: every iteration is a cold process, which is the honest
      // shape of what CI and a developer actually run.
      for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
        await generate(outPath);
      }

      const samples: number[] = [];
      for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
        samples.push(await generate(outPath));
      }

      // Proof the script did the work: a generator that wrote `{}` would otherwise post an
      // excellent time.
      const document = JSON.parse(await readFile(outPath, "utf8")) as {
        openapi: string;
        paths: Record<string, unknown>;
      };
      expect(document.openapi).toBe("3.1.0");
      expect(Object.keys(document.paths).sort()).toEqual([...EXPECTED_PATHS].sort());

      const median = report("generate-openapi.ts", samples);
      console.log(`openapi generation: ${median.toFixed(1)}ms (target < ${TARGET_MS}ms)`);

      expect(median).toBeLessThan(TARGET_MS);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  120_000,
);
