/**
 * Seeded-violation check for the QA-16 raw-pool guardrail (S-01, docs/security/findings-register.md).
 *
 * The API connects through PgBouncer as one database login. A query on the pool itself runs as that
 * login, with no `SET LOCAL ROLE studafy_app` and no `app.school_id`: Row-Level Security then either
 * does not apply (a login that can bypass it reads every school) or matches nothing. Module code must
 * go through withTenantTx/withSystemTx; the few files that still query the pool are allowlisted in the
 * root eslint.config.js (RAW_POOL_QUERY_ALLOWLIST_COUNTS), each with its reason and query count.
 *
 * packages/config/rules/no-raw-pool-query.test.ts proves the rule's logic. This suite proves the
 * wiring through the real root config, exactly as `bun run lint` runs in CI, and that each allowlisted
 * file holds exactly the raw queries it was listed with: no new one hides there, and a fixed file
 * cannot stay listed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { ESLint } from "eslint";

import type { Linter } from "eslint";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// The root config is plain JS with no type declarations; loaded by URL so tsc does not resolve it.
const rootConfig = (await import(pathToFileURL(path.join(REPO_ROOT, "eslint.config.js")).href)) as {
  default: Linter.Config[];
  RAW_POOL_QUERY_ALLOWLIST: string[];
  RAW_POOL_QUERY_ALLOWLIST_COUNTS: Record<string, number>;
};
const { RAW_POOL_QUERY_ALLOWLIST, RAW_POOL_QUERY_ALLOWLIST_COUNTS: counts } = rootConfig;
const RULE_ID = "studafy/no-raw-pool-query";
const ERROR_SEVERITY = 2;

const eslint = new ESLint({ cwd: REPO_ROOT });

async function rawPoolMessages(code: string, relativePath: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, relativePath) });
  return result!.messages.filter((message) => message.ruleId === RULE_ID);
}

const SEEDED = [
  "type Database = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;",
  "export async function readSchool(database: Database, schoolId: string) {",
  "  return database<{ name: string }[]>`SELECT name FROM app.schools WHERE id = ${schoolId}`;",
  "}",
].join("\n");

describe("raw pool guardrail (seeded violation)", () => {
  test("a query on the raw pool is a lint error in apps/api/src/modules", async () => {
    const messages = await rawPoolMessages(
      SEEDED,
      "apps/api/src/modules/seeded/seeded-violation.ts",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.severity).toBe(ERROR_SEVERITY);
    expect(messages[0]!.line).toBe(3);
  }, 60_000);

  test("module tests are not covered", async () => {
    const messages = await rawPoolMessages(SEEDED, "apps/api/src/modules/seeded/seeded.test.ts");

    expect(messages).toEqual([]);
  }, 60_000);

  test("each allowlisted file holds exactly its recorded raw queries", async () => {
    expect(RAW_POOL_QUERY_ALLOWLIST.length).toBeGreaterThan(0);
    // The real config minus the allowlist's "off" block.
    const strict = new ESLint({
      cwd: REPO_ROOT,
      overrideConfigFile: true,
      overrideConfig: rootConfig.default.filter(
        (block) => block.files !== RAW_POOL_QUERY_ALLOWLIST,
      ),
    });
    for (const file of RAW_POOL_QUERY_ALLOWLIST) {
      const filePath = path.join(REPO_ROOT, file);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a repo path from the allowlist above
      const [result] = await strict.lintText(readFileSync(filePath, "utf8"), { filePath });
      const hits = result!.messages.filter((message) => message.ruleId === RULE_ID).length;
      // eslint-disable-next-line security/detect-object-injection -- `file` iterates the allowlist's own keys
      expect(hits, `${file}: update RAW_POOL_QUERY_ALLOWLIST_COUNTS`).toBe(counts[file]!);
    }
  }, 120_000);
});
