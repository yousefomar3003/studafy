/**
 * Seeded-violation check for the ST-297 SQL guardrail.
 *
 * packages/config/rules/no-interpolated-sql.test.ts proves the rule's logic in isolation. This
 * suite proves the *wiring*: it lints seeded source through the repository's real root
 * eslint.config.js, at a path inside apps/api/src, exactly as `bun run lint` in CI does. If the rule
 * is unregistered, downgraded to a warning, or its `files` glob stops covering the API's source,
 * the seeded violation stops producing an error and this suite fails CI.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { ESLint } from "eslint";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const RULE_ID = "studafy/no-interpolated-sql";
const ERROR_SEVERITY = 2;

const eslint = new ESLint({ cwd: REPO_ROOT });

async function sqlRuleMessages(code: string, relativePath: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, relativePath) });
  return result!.messages.filter((message) => message.ruleId === RULE_ID);
}

const SEEDED_SOURCE_PATH = "apps/api/src/modules/seeded/seeded-violation.ts";

describe("SQL interpolation guardrail (seeded violation)", () => {
  test("interpolating a request value into .unsafe() SQL is a lint error in apps/api/src", async () => {
    const messages = await sqlRuleMessages(
      [
        "export function findUser(tx: { unsafe(sql: string): unknown }, email: string) {",
        "  return tx.unsafe(`SELECT id FROM app.users WHERE email = '${email}'`);",
        "}",
      ].join("\n"),
      SEEDED_SOURCE_PATH,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.severity).toBe(ERROR_SEVERITY);
    expect(messages[0]!.line).toBe(2);
  }, 60_000);

  test("string concatenation into .unsafe() SQL is a lint error in apps/api/src", async () => {
    const messages = await sqlRuleMessages(
      [
        "export function findUser(tx: { unsafe(sql: string): unknown }, id: string) {",
        '  return tx.unsafe("SELECT email FROM app.users WHERE id = " + id);',
        "}",
      ].join("\n"),
      SEEDED_SOURCE_PATH,
    );

    expect(messages.map((message) => message.severity)).toEqual([ERROR_SEVERITY]);
  }, 60_000);

  test("the parameterized equivalents pass", async () => {
    const messages = await sqlRuleMessages(
      [
        "type Tx = {",
        "  <T>(strings: TemplateStringsArray, ...values: unknown[]): T;",
        "  unsafe(sql: string, params?: unknown[]): unknown;",
        "};",
        "export function findUser(tx: Tx, email: string) {",
        "  return tx`SELECT id FROM app.users WHERE email = ${email}`;",
        "}",
        "export function findUserById(tx: Tx, id: string) {",
        '  return tx.unsafe("SELECT email FROM app.users WHERE id = $1", [id]);',
        "}",
      ].join("\n"),
      SEEDED_SOURCE_PATH,
    );

    expect(messages).toEqual([]);
  }, 60_000);
});
