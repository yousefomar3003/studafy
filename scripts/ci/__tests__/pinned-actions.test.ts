/**
 * QA-006: CI runs only third-party actions pinned to a commit SHA.
 *
 * `scripts/ci/check-pinned-actions.sh` fails on any `uses:` that names a tag or branch; this keeps
 * the repository passing it, and checks that the script really does catch an unpinned reference.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, describe, expect, test } from "bun:test";

const script = resolve(import.meta.dir, "../check-pinned-actions.sh");
const scratch = mkdtempSync(join(tmpdir(), "pinned-actions-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function check(directory?: string) {
  const run = Bun.spawnSync(["bash", script, ...(directory ? [directory] : [])]);
  return { code: run.exitCode, stderr: run.stderr.toString() };
}

function workflowDir(name: string, body: string): string {
  const directory = join(scratch, name);
  mkdirSync(join(directory, "workflows"), { recursive: true });
  writeFileSync(join(directory, "workflows", "ci.yml"), body);
  return directory;
}

describe("action pinning (QA-006)", () => {
  test("every action in this repository is pinned to a commit SHA", () => {
    const result = check();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  test("a tag-pinned action fails the check", () => {
    const directory = workflowDir(
      "tagged",
      "jobs:\n  a:\n    steps:\n      - uses: actions/cache@v4\n",
    );
    const result = check(directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("actions/cache@v4");
  });

  test("SHA pins, local actions and container images pass", () => {
    const directory = workflowDir(
      "pinned",
      [
        "jobs:",
        "  a:",
        "    steps:",
        "      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0",
        "      - uses: ./.github/actions/setup-bun-workspace",
        "      - uses: docker://alpine:3.20",
        "",
      ].join("\n"),
    );
    expect(check(directory).code).toBe(0);
  });
});
