import { resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runMigrationCommand } from "../../../../packages/db/src/runner";
import { integrationEnabled, runnerEnv, testDatabase } from "../../../../packages/db/tests/helpers";
import { withTenantTx } from "../db/tenant-tx";

import { SENSITIVE_KEYS, auditAction, emitAuditLog, redactPayload } from "./auditEmitter";

import type { AuditAction } from "./auditEmitter";

// ---------------------------------------------------------------------------
// Unit tests -- redactPayload
// ---------------------------------------------------------------------------

describe("redactPayload", () => {
  test("redacts root-level sensitive keys", () => {
    const input = { name: "Ada", password: "s3cret", email: "ada@example.com" };
    const result = redactPayload(input);

    expect(result.name).toBe("Ada");
    expect(result.password).toBe("[REDACTED]");
    expect(result.email).toBe("ada@example.com");
  });

  test("redacts case-insensitively", () => {
    const input = { PASSWORD: "a", Password: "b", token: "t" };
    const result = redactPayload(input);

    expect(result.PASSWORD).toBe("[REDACTED]");
    expect(result.Password).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
  });

  test("redacts nested sensitive keys", () => {
    const input = {
      user: { name: "Ada", credentials: { password: "s3cret", api_key: "k" } },
    };
    const result = redactPayload(input) as {
      user: { name: string; credentials: { password: string; api_key: string } };
    };

    expect(result.user.name).toBe("Ada");
    expect(result.user.credentials.password).toBe("[REDACTED]");
    expect(result.user.credentials.api_key).toBe("[REDACTED]");
  });

  test("preserves non-sensitive fields", () => {
    const input = { id: "123", status: "active", count: 42, flag: true };
    const result = redactPayload(input);

    expect(result).toEqual(input);
  });

  test("handles empty object", () => {
    expect(redactPayload({})).toEqual({});
  });

  test("passes through arrays unchanged", () => {
    const input = { tags: ["a", "b"], items: [{ id: 1 }, { id: 2 }] };
    const result = redactPayload(input);

    expect(result.tags).toEqual(["a", "b"]);
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("does not mutate the original object", () => {
    const input = { password: "s3cret", name: "Ada" };
    redactPayload(input);

    expect(input.password).toBe("s3cret");
  });

  test("SENSITIVE_KEYS contains expected entries", () => {
    expect(SENSITIVE_KEYS.has("password")).toBe(true);
    expect(SENSITIVE_KEYS.has("token")).toBe(true);
    expect(SENSITIVE_KEYS.has("ssn")).toBe(true);
    expect(SENSITIVE_KEYS.has("credit_card")).toBe(true);
    expect(SENSITIVE_KEYS.has("api_key")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests -- auditAction middleware
// ---------------------------------------------------------------------------

describe("auditAction middleware", () => {
  test("sets auditMeta in context", async () => {
    let captured: unknown;
    const middleware = auditAction("insert", "students");
    const fakeContext = {
      set: (_key: string, value: unknown) => {
        captured = value;
      },
    };
    const next = async () => undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, not a real Hono context
    await (middleware as any)(fakeContext, next);

    expect(captured).toEqual({ action: "insert", table: "students" });
  });

  test("passes through all audit action types", async () => {
    const actions: AuditAction[] = [
      "insert",
      "update",
      "delete",
      "login",
      "logout",
      "export",
      "permission_change",
    ];

    for (const action of actions) {
      let captured: unknown;
      const middleware = auditAction(action, "test_table");
      const fakeContext = {
        set: (_key: string, value: unknown) => {
          captured = value;
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, not a real Hono context
      await (middleware as any)(fakeContext, async () => undefined);

      expect(captured).toEqual({ action, table: "test_table" });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests -- emitAuditLog (gated behind AUDIT_EMITTER_INTEGRATION)
// ---------------------------------------------------------------------------

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../../db/migrations");

type TestDatabase = Awaited<ReturnType<typeof testDatabase>>;
let database: TestDatabase | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describe("emitAuditLog", () => {
  integrationTest("inserts a row with correct GUC-derived identity", async () => {
    const schoolId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const requestId = crypto.randomUUID();

    await withTenantTx(database!.sql, { schoolId, userId, requestId }, async (tx) => {
      await emitAuditLog(tx, {
        action: "insert",
        targetTable: "students",
        targetId: crypto.randomUUID(),
        newValues: { name: "Ada Lovelace" },
      });
    });

    const rows = await database!.sql`
      SELECT school_id, actor_id, action, target_table, old_values, new_values, request_id
      FROM app.audit_logs
      WHERE school_id = ${schoolId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("insert");
    expect(rows[0].target_table).toBe("students");
    expect(rows[0].old_values).toBeNull();
    expect(rows[0].new_values).toEqual({ name: "Ada Lovelace" });
    expect(String(rows[0].school_id)).toBe(schoolId);
    expect(String(rows[0].actor_id)).toBe(userId);
    expect(String(rows[0].request_id)).toBe(requestId);
  });

  integrationTest("writes update audit with both old and new values", async () => {
    const schoolId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();

    await withTenantTx(database!.sql, { schoolId, userId }, async (tx) => {
      await emitAuditLog(tx, {
        action: "update",
        targetTable: "students",
        targetId,
        oldValues: { name: "Old Name", password: "old-pass" },
        newValues: { name: "New Name", password: "new-pass" },
      });
    });

    const rows = await database!.sql`
      SELECT old_values, new_values FROM app.audit_logs
      WHERE school_id = ${schoolId} AND target_id = ${targetId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].old_values).toEqual({ name: "Old Name", password: "old-pass" });
    expect(rows[0].new_values).toEqual({ name: "New Name", password: "new-pass" });
  });

  integrationTest("nulls actor_id when user_id GUC is unset", async () => {
    const schoolId = crypto.randomUUID();

    await withTenantTx(database!.sql, { schoolId }, async (tx) => {
      await emitAuditLog(tx, {
        action: "login",
        targetTable: "users",
        targetId: crypto.randomUUID(),
      });
    });

    const rows = await database!.sql`
      SELECT actor_id FROM app.audit_logs WHERE school_id = ${schoolId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBeNull();
  });

  integrationTest("audit write failure rolls back the mutation", async () => {
    const schoolId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    let mutationCommitted = false;

    const pooled = postgres(database!.url, { max: 2, ssl: false, prepare: false });
    try {
      await expect(
        withTenantTx(pooled, { schoolId, userId }, async (tx) => {
          await tx`CREATE TEMPORARY TABLE _audit_test (id int)`;
          await tx`INSERT INTO _audit_test VALUES (1)`;
          mutationCommitted = true;

          await emitAuditLog(tx, {
            action: "not_a_valid_action" as AuditAction,
            targetTable: "students",
            targetId: crypto.randomUUID(),
          });
        }),
      ).rejects.toThrow();

      expect(mutationCommitted).toBe(true);

      const check = await withTenantTx(pooled, { schoolId }, async (tx) => {
        const [row] = await tx<{ exists: boolean }[]>`
          SELECT to_regclass('pg_temp._audit_test') IS NOT NULL AS exists
        `;
        return row!.exists;
      });
      expect(check).toBe(false);
    } finally {
      await pooled.end({ timeout: 1 });
    }
  });

  integrationTest("redacted payload is emitted when caller redacts before passing", async () => {
    const schoolId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const targetId = crypto.randomUUID();

    const rawPayload = { name: "Ada", password: "s3cret", ssn: "123-45-6789" };
    const redacted = redactPayload(rawPayload);

    await withTenantTx(database!.sql, { schoolId, userId }, async (tx) => {
      await emitAuditLog(tx, {
        action: "insert",
        targetTable: "students",
        targetId,
        newValues: redacted,
      });
    });

    const rows = await database!.sql`
      SELECT new_values FROM app.audit_logs
      WHERE school_id = ${schoolId} AND target_id = ${targetId}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0].new_values).toEqual({
      name: "Ada",
      password: "[REDACTED]",
      ssn: "[REDACTED]",
    });
  });
});
