import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

/**
 * Proves the generated-types validation does its job: it passes when the file exists and is non-empty,
 * and exits 1 when the file is missing. The generated file is gitignored (see root .gitignore), so the
 * validation script is a simple existence + size check rather than a content-level drift comparison.
 */

const PACKAGE_ROOT = path.join(import.meta.dir, "..");
const CHECK_DRIFT = path.join(PACKAGE_ROOT, "scripts", "check-drift.ts");

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

describe("client type validation", () => {
  test("passes when the generated types file exists and is non-empty", async () => {
    const { exitCode, stdout, stderr } = await runCheckDrift();
    if (exitCode !== 0) {
      console.error(stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("generated at");
  }, 30_000);

  test("fails when the generated types file is missing and exits 1", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "studafy-validate-sim-"));
    const missing = path.join(scratch, "nonexistent.ts");
    try {
      const { exitCode, stderr } = await runCheckDrift({ CLIENT_TYPES_COMPARE: missing });

      expect(exitCode).toBe(1);
      expect(stderr).toContain("not found");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
