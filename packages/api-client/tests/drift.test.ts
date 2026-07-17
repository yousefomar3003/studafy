import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

/**
 * Proves the CI drift gate does its job: a manual edit to the generated types is flagged, the change
 * vector is logged, and the runner exits 1. The simulation points the drift script's comparison
 * target at a deliberately-corrupted copy via CLIENT_TYPES_COMPARE, so the committed file and the git
 * tree are never touched.
 */

const PACKAGE_ROOT = path.join(import.meta.dir, "..");
const CHECK_DRIFT = path.join(PACKAGE_ROOT, "scripts", "check-drift.ts");
const COMMITTED_TYPES = path.join(PACKAGE_ROOT, "src", "generated-types.ts");

async function runCheckDrift(env: Record<string, string> = {}): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const proc = Bun.spawn(["bun", "run", CHECK_DRIFT], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stderr: await new Response(proc.stderr).text(),
    stdout: await new Response(proc.stdout).text(),
  };
}

describe("client type drift detection", () => {
  test("passes when the committed types match the spec", async () => {
    const { exitCode, stdout } = await runCheckDrift();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("in sync");
  }, 30_000);

  test("flags a hand-edited field type, logs the change vector, and exits 1", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "studafy-drift-sim-"));
    const corrupted = path.join(scratch, "generated-types.ts");
    try {
      // Start from the real generated file and edit a single field type by hand — the exact kind of
      // manual modification the drift guard exists to catch.
      const original = await readFile(COMMITTED_TYPES, "utf8");
      const edited = original.replace('readonly status: "ok"', "readonly status: number");
      expect(edited).not.toBe(original); // guard: the field we corrupt must actually exist

      await writeFile(corrupted, edited);

      const { exitCode, stderr } = await runCheckDrift({ CLIENT_TYPES_COMPARE: corrupted });

      expect(exitCode).toBe(1);
      expect(stderr).toContain("type drift");
      // The logged change vector is a real unified diff naming the corrupted field.
      expect(stderr).toContain('readonly status: "ok"');
      expect(stderr).toContain("readonly status: number");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
