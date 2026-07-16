import { resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runMigrationCommand } from "../../../../packages/db/src/runner";
import { integrationEnabled, runnerEnv, testDatabase } from "../../../../packages/db/tests/helpers";

import { withTenantTx } from "./tenant-tx";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../../db/migrations");

type TestDatabase = Awaited<ReturnType<typeof testDatabase>>;
let database: TestDatabase | undefined;

beforeAll(async () => {
  if (!integrationEnabled) {
    return;
  }
  database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describe("withTenantTx", () => {
  integrationTest("sets app.school_id GUC inside the transaction", async () => {
    const schoolId = crypto.randomUUID();
    const result = await withTenantTx(database!.sql, { schoolId }, async (tx) => {
      const [row] = await tx<{ school: string }[]>`
        SELECT current_setting('app.school_id') AS school
      `;
      return row!.school;
    });
    expect(result).toBe(schoolId);
  });

  integrationTest("sets app.user_id GUC when userId is provided", async () => {
    const schoolId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const result = await withTenantTx(database!.sql, { schoolId, userId }, async (tx) => {
      const [row] = await tx<{ school: string; user: string }[]>`
          SELECT
            current_setting('app.school_id') AS school,
            current_setting('app.user_id') AS "user"
        `;
      return row!;
    });
    expect(result.school).toBe(schoolId);
    expect(result.user).toBe(userId);
  });

  integrationTest("omits app.user_id GUC when userId is omitted", async () => {
    const schoolId = crypto.randomUUID();
    const result = await withTenantTx(database!.sql, { schoolId }, async (tx) => {
      const [row] = await tx<{ user: string }[]>`
        SELECT current_setting('app.user_id', true) AS "user"
      `;
      return row!.user;
    });
    expect(result).toBe("");
  });

  integrationTest("sets the studafy_app role", async () => {
    const schoolId = crypto.randomUUID();
    const result = await withTenantTx(database!.sql, { schoolId }, async (tx) => {
      const [row] = await tx<{ role: string }[]>`SELECT current_role AS role`;
      return row!.role;
    });
    expect(result).toBe("studafy_app");
  });

  integrationTest("rolls back on callback error", async () => {
    const schoolId = crypto.randomUUID();
    const pooled = postgres(database!.url, { max: 2, ssl: false, prepare: false });
    try {
      await expect(
        withTenantTx(pooled, { schoolId }, async (tx) => {
          await tx`SELECT 1`;
          throw new Error("intentional rollback");
        }),
      ).rejects.toThrow("intentional rollback");

      const afterRollback = await withTenantTx(pooled, { schoolId }, async (tx) => {
        const [row] = await tx<{ school: string }[]>`
          SELECT current_setting('app.school_id') AS school
        `;
        return row!.school;
      });
      expect(afterRollback).toBe(schoolId);
    } finally {
      await pooled.end({ timeout: 1 });
    }
  });

  integrationTest("shows no GUC leakage across pooled connections", async () => {
    const pooled = postgres(database!.url, { max: 2, ssl: false, prepare: false });
    try {
      const schoolA = crypto.randomUUID();
      const schoolB = crypto.randomUUID();

      await withTenantTx(pooled, { schoolId: schoolA }, async (tx) => {
        const [row] = await tx<{ school: string }[]>`
          SELECT current_setting('app.school_id') AS school
        `;
        expect(row!.school).toBe(schoolA);
      });

      await withTenantTx(pooled, { schoolId: schoolB }, async (tx) => {
        const [row] = await tx<{ school: string }[]>`
          SELECT current_setting('app.school_id') AS school
        `;
        expect(row!.school).toBe(schoolB);
      });
    } finally {
      await pooled.end({ timeout: 1 });
    }
  });
});
