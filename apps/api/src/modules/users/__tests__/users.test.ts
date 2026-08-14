/**
 * User management service tests (ST-093).
 *
 * Integration tests that require a live PostgreSQL instance. Each test creates its own
 * school and user data via the test harness factories, then exercises the service
 * functions directly within a tenant transaction.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/users/__tests__
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  createUser as createUserFactory,
  assignRole,
  createRefreshSession,
  integrationEnabled,
  type TestDatabase,
} from "../../../../tests/harness";
import {
  listUsers,
  getUser,
  getUserStatusCounts,
  createUser,
  updateUser,
  updateUserRole,
  deactivateUser,
} from "../user-service";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Skip when no database is available
// ---------------------------------------------------------------------------

const describeDb = integrationEnabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('role', 'studafy_app', true)`;
    result = await fn(tx);
  });
  return result as T;
}

// ---------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------

describeDb("listUsers", () => {
  test("returns paginated results with roles", async () => {
    const school = await createSchool(db.sql);
    const user1 = await createUserFactory(db.sql, school.id, {
      email: "alice@test.local",
      displayName: "Alice",
    });
    const user2 = await createUserFactory(db.sql, school.id, {
      email: "bob@test.local",
      displayName: "Bob",
    });
    await assignRole(db.sql, school.id, user1.id, "INSTRUCTOR");
    await assignRole(db.sql, school.id, user2.id, "STUDENT");

    const { rows, next_cursor } = await withTx((tx) => listUsers(tx, school.id, { limit: 10 }));

    expect(rows.length).toBe(2);
    expect(next_cursor).toBeNull();

    const alice = rows.find((r) => r.email === "alice@test.local");
    expect(alice).toBeDefined();
    expect(alice!.roles).toContain("INSTRUCTOR");
    expect(alice!.display_name).toBe("Alice");

    const bob = rows.find((r) => r.email === "bob@test.local");
    expect(bob).toBeDefined();
    expect(bob!.roles).toContain("STUDENT");
  });

  test("filters by role", async () => {
    const school = await createSchool(db.sql);
    const user1 = await createUserFactory(db.sql, school.id, {
      email: "inst@test.local",
    });
    const user2 = await createUserFactory(db.sql, school.id, {
      email: "stud@test.local",
    });
    await assignRole(db.sql, school.id, user1.id, "INSTRUCTOR");
    await assignRole(db.sql, school.id, user2.id, "STUDENT");

    const { rows } = await withTx((tx) =>
      listUsers(tx, school.id, { limit: 10, role: "INSTRUCTOR" }),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("inst@test.local");
  });

  test("filters by status", async () => {
    const school = await createSchool(db.sql);
    await createUserFactory(db.sql, school.id, {
      email: "active@test.local",
      status: "active",
    });
    await createUserFactory(db.sql, school.id, {
      email: "invited@test.local",
      status: "invited",
    });

    const { rows } = await withTx((tx) =>
      listUsers(tx, school.id, { limit: 10, status: "invited" }),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("invited@test.local");
  });

  test("searches by email", async () => {
    const school = await createSchool(db.sql);
    await createUserFactory(db.sql, school.id, {
      email: "findme@example.com",
      displayName: "Find Me",
    });
    await createUserFactory(db.sql, school.id, {
      email: "other@example.com",
      displayName: "Other User",
    });

    const { rows } = await withTx((tx) =>
      listUsers(tx, school.id, { limit: 10, search: "findme" }),
    );

    expect(rows.length).toBe(1);
    expect(rows[0]!.email).toBe("findme@example.com");
  });

  test("cursor pagination returns next page", async () => {
    const school = await createSchool(db.sql);
    for (let i = 0; i < 5; i++) {
      await createUserFactory(db.sql, school.id, {
        email: `user${i}@test.local`,
      });
    }

    const page1 = await withTx((tx) => listUsers(tx, school.id, { limit: 2 }));
    expect(page1.rows.length).toBe(2);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await withTx((tx) =>
      listUsers(tx, school.id, { limit: 2, cursor: page1.next_cursor! }),
    );
    expect(page2.rows.length).toBe(2);

    // Ensure no overlap
    const page1Ids = page1.rows.map((r) => r.id);
    const page2Ids = page2.rows.map((r) => r.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getUserStatusCounts
// ---------------------------------------------------------------------------

describeDb("getUserStatusCounts", () => {
  test("counts users per status, scoped to the school", async () => {
    const school = await createSchool(db.sql);
    const otherSchool = await createSchool(db.sql);

    await createUserFactory(db.sql, school.id, { email: "a1@test.local", status: "active" });
    await createUserFactory(db.sql, school.id, { email: "a2@test.local", status: "active" });
    await createUserFactory(db.sql, school.id, { email: "i1@test.local", status: "invited" });
    await createUserFactory(db.sql, school.id, { email: "s1@test.local", status: "suspended" });
    // Belongs to a different school — must not be counted.
    await createUserFactory(db.sql, otherSchool.id, {
      email: "other@test.local",
      status: "active",
    });

    const counts = await withTx((tx) => getUserStatusCounts(tx, school.id));

    expect(counts).toEqual({ invited: 1, active: 2, suspended: 1, archived: 0 });
  });

  test("returns all-zero counts for a school with no users", async () => {
    const school = await createSchool(db.sql);

    const counts = await withTx((tx) => getUserStatusCounts(tx, school.id));

    expect(counts).toEqual({ invited: 0, active: 0, suspended: 0, archived: 0 });
  });
});

// ---------------------------------------------------------------------------
// getUser
// ---------------------------------------------------------------------------

describeDb("getUser", () => {
  test("returns user with roles", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id, {
      email: "getuser@test.local",
      displayName: "Get User",
    });
    await assignRole(db.sql, school.id, user.id, "ORG_ADMIN");

    const result = await withTx((tx) => getUser(tx, school.id, user.id));

    expect(result).toBeDefined();
    expect(result!.email).toBe("getuser@test.local");
    expect(result!.display_name).toBe("Get User");
    expect(result!.roles).toContain("ORG_ADMIN");
  });

  test("returns undefined for non-existent ID", async () => {
    const school = await createSchool(db.sql);
    const result = await withTx((tx) =>
      getUser(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createUser
// ---------------------------------------------------------------------------

describeDb("createUser", () => {
  test("creates a user with role and emits audit", async () => {
    const school = await createSchool(db.sql);

    const user = await withTx((tx) =>
      createUser(tx, school.id, {
        email: "newuser@test.local",
        display_name: "New User",
        role: "TEACHING_ASSISTANT",
      }),
    );

    expect(user).toBeDefined();
    expect(user.email).toBe("newuser@test.local");
    expect(user.display_name).toBe("New User");
    expect(user.status).toBe("invited");
    expect(user.roles).toContain("TEACHING_ASSISTANT");
  });

  test("rejects duplicate email within school", async () => {
    const school = await createSchool(db.sql);
    await createUserFactory(db.sql, school.id, { email: "dup@test.local" });

    await expect(
      withTx((tx) =>
        createUser(tx, school.id, {
          email: "dup@test.local",
          role: "STUDENT",
        }),
      ),
    ).rejects.toThrow();
  });

  test("allows same email in different schools", async () => {
    const school1 = await createSchool(db.sql);
    const school2 = await createSchool(db.sql);

    const user1 = await withTx((tx) =>
      createUser(tx, school1.id, {
        email: "shared@test.local",
        role: "STUDENT",
      }),
    );

    const user2 = await withTx((tx) =>
      createUser(tx, school2.id, {
        email: "shared@test.local",
        role: "INSTRUCTOR",
      }),
    );

    expect(user1.id).not.toBe(user2.id);
  });
});

// ---------------------------------------------------------------------------
// updateUser
// ---------------------------------------------------------------------------

describeDb("updateUser", () => {
  test("modifies display_name", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id, {
      email: "update@test.local",
      displayName: "Original Name",
    });

    const updated = await withTx((tx) =>
      updateUser(tx, school.id, user.id, { display_name: "Updated Name" }),
    );

    expect(updated.display_name).toBe("Updated Name");
    expect(updated.email).toBe("update@test.local");
  });

  test("returns 404 for non-existent user", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx((tx) =>
        updateUser(tx, school.id, "00000000-0000-0000-0000-000000000000", {
          display_name: "Ghost",
        }),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// updateUserRole
// ---------------------------------------------------------------------------

describeDb("updateUserRole", () => {
  test("replaces the user's role", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id, {
      email: "roleupdate@test.local",
    });
    await assignRole(db.sql, school.id, user.id, "STUDENT");

    const updated = await withTx((tx) =>
      updateUserRole(tx, school.id, user.id, { role: "INSTRUCTOR" }),
    );

    expect(updated.roles).toContain("INSTRUCTOR");
    expect(updated.roles).not.toContain("STUDENT");
  });

  test("returns 404 for non-existent user", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx((tx) =>
        updateUserRole(tx, school.id, "00000000-0000-0000-0000-000000000000", {
          role: "STUDENT",
        }),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deactivateUser
// ---------------------------------------------------------------------------

describeDb("deactivateUser", () => {
  test("sets status to suspended and revokes pending invitations", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id, {
      email: "deactivate@test.local",
      status: "active",
    });

    const result = await deactivateUser({
      database: db.sql,
      denylist: null,
      tenant: { schoolId: school.id },
      targetUserId: user.id,
    });

    expect(result.status).toBe("suspended");
    expect(result.invitations_revoked).toBe(0);

    // Verify status changed
    const updated = await withTx((tx) => getUser(tx, school.id, user.id));
    expect(updated!.status).toBe("suspended");
  });

  test("revokes pending invitations for the user's email", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id, {
      email: "invited-deactivate@test.local",
      status: "invited",
    });

    // Create a pending invitation
    await db.sql.begin(async (tx) => {
      await tx`SELECT set_config('role', 'studafy_app', true)`;
      await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
      await tx`
        INSERT INTO app.invitations (
          school_id, email, normalized_email, role, token_hash, expires_at
        ) VALUES (
          ${school.id},
          'invited-deactivate@test.local',
          'invited-deactivate@test.local',
          'STUDENT'::app.user_role,
          ${Buffer.from("test-token-hash")},
          CURRENT_TIMESTAMP + INTERVAL '7 days'
        )
      `;
    });

    const result = await deactivateUser({
      database: db.sql,
      denylist: null,
      tenant: { schoolId: school.id },
      targetUserId: user.id,
    });

    expect(result.status).toBe("suspended");
    expect(result.invitations_revoked).toBe(1);
  });

  test("returns 404 for non-existent user", async () => {
    const school = await createSchool(db.sql);

    await expect(
      deactivateUser({
        database: db.sql,
        denylist: null,
        tenant: { schoolId: school.id },
        targetUserId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow();
  });

  test("revokes refresh tokens when user has active sessions", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id, {
      email: "session-user@test.local",
      status: "active",
    });

    // Create an active refresh token session
    await createRefreshSession(db.sql, school.id, user.id);

    const result = await deactivateUser({
      database: db.sql,
      denylist: null,
      tenant: { schoolId: school.id },
      targetUserId: user.id,
    });

    expect(result.status).toBe("suspended");
    expect(result.revoked).toBeGreaterThanOrEqual(1);
  });
});
