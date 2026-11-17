/**
 * QA-073: every .trivyignore waiver has a review date, and an expired one fails CI.
 *
 * `scripts/ci/check-trivyignore-expiry.sh` reads the `# review-by: YYYY-MM-DD` line in the comment
 * block above each ignored ID. This keeps the repository passing it and checks that the script
 * really catches a missing, malformed or past date.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, describe, expect, test } from "bun:test";

const script = resolve(import.meta.dir, "../check-trivyignore-expiry.sh");
const scratch = mkdtempSync(join(tmpdir(), "trivyignore-expiry-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function check(options: { body?: string; today?: string } = {}) {
  const args = ["bash", script];
  if (options.body !== undefined) {
    const file = join(scratch, `trivyignore-${crypto.randomUUID()}`);
    writeFileSync(file, options.body);
    args.push(file);
  }
  const env = { ...process.env, ...(options.today ? { TODAY: options.today } : {}) };
  const run = Bun.spawnSync(args, { env });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe(".trivyignore review dates (QA-073)", () => {
  test("every waiver in this repository has a review date that has not passed", () => {
    const result = check();
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  test("a waiver with no review date fails", () => {
    const result = check({ body: "# Some justification.\nCVE-2026-00001\n", today: "2026-11-17" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CVE-2026-00001: no");
  });

  test("a review date that has passed, or is today, fails", () => {
    for (const today of ["2026-12-01", "2026-12-02"]) {
      const result = check({ body: "# Why.\n# review-by: 2026-12-01\nCVE-2026-00002\n", today });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("CVE-2026-00002: waiver expired on 2026-12-01");
    }
  });

  test("a malformed date fails", () => {
    const result = check({ body: "# review-by: 1/12/2027\nCVE-2026-00003\n", today: "2026-11-17" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not YYYY-MM-DD");
  });

  test("a date covers only the ID right below its comment block", () => {
    const body = [
      "# review-by: 2027-02-15",
      "CVE-2026-00004",
      "# Same chain, but this one has no date of its own.",
      "CVE-2026-00005",
      "",
      "# review-by: 2027-02-15",
      "",
      "CVE-2026-00006",
      "",
    ].join("\n");
    const result = check({ body, today: "2026-11-17" });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("CVE-2026-00004");
    expect(result.stderr).toContain("CVE-2026-00005: no");
    expect(result.stderr).toContain("CVE-2026-00006: no");
  });

  test("future dates pass", () => {
    const body =
      "# Why.\n# review-by: 2027-02-15\nCVE-2026-00007\n# review-by: 2027-03-01\nGHSA-xxxx-yyyy-zzzz\n";
    const result = check({ body, today: "2026-11-17" });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 .trivyignore waiver(s)");
  });
});
