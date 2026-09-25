// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import { parser } from "typescript-eslint";

import noInterpolatedSql from "./no-interpolated-sql.js";

// RuleTester drives its own describe/it blocks (Mocha-shaped by default); pointing it at bun:test's
// globals is the documented way to run it under a non-Mocha framework.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module", parser },
});

const dynamic = [{ messageId: "dynamicUnsafeSql" }];

ruleTester.run("no-interpolated-sql", noInterpolatedSql, {
  valid: [
    // Tagged templates are the default path: every ${} is a bound parameter.
    "tx`SELECT * FROM app.users WHERE email ILIKE ${`%${search}%`}`;",
    'tx.unsafe("SET LOCAL ROLE studafy_app");',
    "tx.unsafe(`SELECT 1`);",
    // Values travel as bound parameters, not SQL text.
    "tx.unsafe(\"SELECT set_config('app.school_id', $1, true)\", [schoolId]);",
    // Module constants — the `${tx.unsafe(COLUMNS)}` column-list idiom used across apps/api.
    "const COLUMNS = `id, name`; tx`SELECT ${tx.unsafe(COLUMNS)} FROM app.t`;",
    "const MODE = 'relaxed_order'; tx.unsafe(`SET LOCAL hnsw.iterative_scan = '${MODE}'`);",
    "const A = 'id'; const B = A + ', name'; tx.unsafe('SELECT ' + B + ' FROM app.t');",
    "const TABLE = 'app.t' as const; tx.unsafe(`SELECT * FROM ${TABLE}`);",
    "const LIMIT = 50; tx.unsafe(`SELECT 1 LIMIT ${LIMIT}`);",
    // Not a SQL client call.
    "unsafe(`${x}`);",
    "obj['unsafe'](`${x}`);",
  ],
  invalid: [
    { code: "tx.unsafe(`SELECT * FROM app.users WHERE email = '${email}'`);", errors: dynamic },
    { code: "tx.unsafe('SELECT * FROM app.users WHERE id = ' + id);", errors: dynamic },
    { code: "function run(tx, query) { return tx.unsafe(query); }", errors: dynamic },
    { code: "let q = 'SELECT 1'; tx.unsafe(q);", errors: dynamic },
    { code: "const q = `SELECT * FROM t WHERE a = ${a}`; tx.unsafe(q);", errors: dynamic },
    { code: "tx.unsafe(buildQuery(filters));", errors: dynamic },
    { code: "tx.unsafe(input.sql);", errors: dynamic },
    { code: "tx.unsafe(...args);", errors: dynamic },
    { code: "const { sql } = config; tx.unsafe(sql);", errors: dynamic },
    { code: "const a = b; const b = a; tx.unsafe(a);", errors: dynamic },
    // Interpolation nested inside a static-looking fragment is still interpolation.
    { code: "tx`SELECT ${tx.unsafe(`${column}`)} FROM app.t`;", errors: dynamic },
    { code: "tx.unsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`);", errors: dynamic },
  ],
});
