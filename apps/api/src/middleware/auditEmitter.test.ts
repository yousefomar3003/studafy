import { resolve } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runMigrationCommand } from "../../../../packages/db/src/runner";
import { integrationEnabled, runnerEnv, testDatabase } from "../../../../packages/db/tests/helpers";
import { createSchool, createUser } from "../../tests/harness";
import { withTenantTx } from "../db/tenant-tx";

import {
  SENSITIVE_KEYS,
  auditAction,
  auditPayload,
  emitAuditLog,
  redactPayload,
} from "./auditEmitter";

import type { AuditAction } from "./auditEmitter";

// ---------------------------------------------------------------------------
// Unit tests -- redactPayload
// ---------------------------------------------------------------------------

describe("auditPayload", () => {
  // ck_audit_logs_payload: insert = (null, after), update = (before, after), delete = (before, null).
  test("an update without before-values gets an empty object, not a failed statement", () => {
    expect(auditPayload({ action: "update", newValues: { a: 1 } })).toEqual({
      oldValues: {},
      newValues: { a: 1 },
    });
    expect(auditPayload({ action: "update" })).toEqual({ oldValues: {}, newValues: {} });
  });

  test("a delete keeps its before-values and drops any after", () => {
    expect(auditPayload({ action: "delete" })).toEqual({ oldValues: {}, newValues: null });
    expect(auditPayload({ action: "delete", oldValues: { a: 1 }, newValues: { b: 2 } })).toEqual({
      oldValues: { a: 1 },
      newValues: null,
    });
  });

  test("an insert has no before-values and always an after", () => {
    expect(auditPayload({ action: "insert", oldValues: { a: 1 } })).toEqual({
      oldValues: null,
      newValues: {},
    });
  });

  test("other actions pass through", () => {
    expect(auditPayload({ action: "login" })).toEqual({ oldValues: null, newValues: null });
  });
});

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

// app.audit_logs references app.schools (fk_audit_logs_school) and, through (actor_id, school_id),
// app.users (fk_audit_logs_actor), so the GUC identity must name a real school and a user in it.
async function seedTenant(): Promise<{ schoolId: string; userId: string }> {
  const school = await createSchool(database!.sql);
  const user = await createUser(database!.sql, school.id);
  return { schoolId: school.id, userId: user.id };
}

describe("emitAuditLog", () => {
  integrationTest("inserts a row with correct GUC-derived identity", async () => {
    const { schoolId, userId } = await seedTenant();
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
    const { schoolId, userId } = await seedTenant();
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
    const { id: schoolId } = await createSchool(database!.sql);

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
    const { schoolId, userId } = await seedTenant();
    const email = `rollback-${crypto.randomUUID().slice(0, 8)}@test.local`;
    let mutationCommitted = false;

    // withTenantTx runs as studafy_app, which has no TEMPORARY privilege on the database, so the
    // mutation under test is a real tenant-table write rather than a temp table.
    await expect(
      withTenantTx(database!.sql, { schoolId, userId }, async (tx) => {
        await tx`
          INSERT INTO app.users (school_id, email, normalized_email, status)
          VALUES (${schoolId}, ${email}, ${email}, 'active')
        `;
        mutationCommitted = true;

        await emitAuditLog(tx, {
          action: "not_a_valid_action" as AuditAction,
          targetTable: "users",
          targetId: crypto.randomUUID(),
        });
      }),
    ).rejects.toThrow();

    expect(mutationCommitted).toBe(true);

    const rows = await database!.sql`
      SELECT id FROM app.users WHERE school_id = ${schoolId} AND normalized_email = ${email}
    `;
    expect(rows).toHaveLength(0);
  });

  integrationTest("redacted payload is emitted when caller redacts before passing", async () => {
    const { schoolId, userId } = await seedTenant();
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
