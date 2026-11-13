// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import { parser } from "typescript-eslint";

import noRawPoolQuery from "./no-raw-pool-query.js";

// RuleTester drives its own describe/it blocks (Mocha-shaped by default); pointing it at bun:test's
// globals is the documented way to run it under a non-Mocha framework.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module", parser },
});

const raw = [{ messageId: "rawPoolQuery" }];

ruleTester.run("no-raw-pool-query", noRawPoolQuery, {
  valid: [
    // Inside a transaction that set the role and tenant: the normal path.
    "withTenantTx(database, tenant, (tx) => tx`SELECT 1`);",
    "database.begin(async (tx) => { await tx.unsafe('SET LOCAL ROLE studafy_app'); });",
    "tx<{ id: string }[]>`SELECT id FROM app.users`;",
    // Passing the pool along is not querying it.
    "checkDatabase(database);",
    "const pools = { primary: database };",
    // Not one of the pool names.
    "sql`SELECT 1`;",
    "options.databaseUrl`x`;",
    "database['unsafe']('SELECT 1');",
  ],
  invalid: [
    { code: "database`SELECT 1`;", errors: raw },
    { code: "database<{ id: string }[]>`SELECT id FROM app.schools`;", errors: raw },
    { code: "db`UPDATE app.plans SET is_active = false`;", errors: raw },
    { code: "deps.database`SELECT 1`;", errors: raw },
    { code: "pools.primary`SELECT 1`;", errors: raw },
    { code: "pools.readReplica<Row[]>`SELECT 1`;", errors: raw },
    { code: "database.unsafe('SELECT 1');", errors: raw },
    { code: "c.var.db.unsafe('SELECT 1');", errors: raw },
  ],
});
