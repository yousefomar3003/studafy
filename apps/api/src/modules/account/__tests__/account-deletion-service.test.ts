/**
 * Self-service account deletion against a real database (000143's grace period): scheduling
 * signs out and sets the due date without detaching anything, member-password accounts must
 * re-enter their member ID and password, and cancelling clears the schedule.
 *
 * Skipped unless TEST_DATABASE_URL is set. The detach/erasure that runs on the due date is the
 * worker's account-deletion sweep, tested in apps/workers.
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  createRefreshSession,
  createSchool,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import {
  cancelAccountDeletion,
  DELETION_GRACE_DAYS,
  scheduleAccountDeletion,
} from "../account-deletion-service";

import type { TestDatabase } from "../../../../tests/harness";
import type { AccountDeletionDeps } from "../account-deletion-service";
import type { Role } from "@studafy/constants";
import type { Sql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | null = null;
let schoolId: string;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  ({ id: schoolId } = await createSchool(database.sql));
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

async function asAdmin<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  let result: T;
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx as unknown as Sql);
  });
  return result!;
}

const deps = (): AccountDeletionDeps => ({ database: database!.sql as never, denylist: null });

/** A signed-in user with the given roles; member-password roles get a member code. */
async function seedUser(role: Role) {
  const sql = database!.sql;
  const user = await createUser(sql, schoolId);
  await assignRole(sql, schoolId, user.id, role);
  await createRefreshSession(sql, schoolId, user.id);
  const codes = await asAdmin(
    sql,
    (tx) => tx<{ code: string }[]>`SELECT code FROM app.member_codes WHERE user_id = ${user.id}`,
  );
  return { id: user.id, code: codes[0]?.code ?? null };
}

async function accountState(userId: string) {
  return asAdmin(database!.sql, async (tx) => {
    const [row] = await tx<
      { status: string; roles: number; due: Date | null; live_sessions: number }[]
    >`
      SELECT
        (SELECT status::text FROM app.users WHERE id = ${userId}) AS status,
        (SELECT count(*)::int FROM app.user_roles WHERE user_id = ${userId}) AS roles,
        (SELECT deletion_due_at FROM app.users WHERE id = ${userId}) AS due,
        (SELECT count(*)::int FROM app.refresh_tokens
          WHERE user_id = ${userId} AND revoked_at IS NULL) AS live_sessions
    `;
    return row!;
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof CodedHttpException ? error.code : undefined;
}

describe("scheduleAccountDeletion", () => {
  integrationTest("schedules 14 days out, signs out, and detaches nothing yet", async () => {
    const admin = await seedUser(ROLES.ORG_ADMIN);

    const result = await scheduleAccountDeletion(deps(), { schoolId, userId: admin.id });

    const days = (result.scheduledFor.getTime() - result.requestedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(DELETION_GRACE_DAYS);
    expect(result.completesBy.getTime()).toBeGreaterThan(result.scheduledFor.getTime());
    expect(await accountState(admin.id)).toMatchObject({
      status: "active",
      roles: 1,
      live_sessions: 0,
    });
    expect((await accountState(admin.id)).due).not.toBeNull();
  });

  integrationTest("a second schedule is a 409", async () => {
    const admin = await seedUser(ROLES.ORG_ADMIN);
    await scheduleAccountDeletion(deps(), { schoolId, userId: admin.id });

    expect(await codeOf(scheduleAccountDeletion(deps(), { schoolId, userId: admin.id }))).toBe(
      ERROR_CODES.ACCOUNT_DELETION_ALREADY_SCHEDULED,
    );
  });

  integrationTest(
    "a member-password account must give its own member ID and password",
    async () => {
      const parent = await seedUser(ROLES.PARENT);
      expect(parent.code).not.toBeNull();

      expect(await codeOf(scheduleAccountDeletion(deps(), { schoolId, userId: parent.id }))).toBe(
        ERROR_CODES.ACCOUNT_DELETION_VERIFICATION_FAILED,
      );
      expect(
        await codeOf(
          scheduleAccountDeletion(deps(), {
            schoolId,
            userId: parent.id,
            memberId: "PAR-NOT-MINE",
            password: "pass@1234",
          }),
        ),
      ).toBe(ERROR_CODES.ACCOUNT_DELETION_VERIFICATION_FAILED);
      expect(
        await codeOf(
          scheduleAccountDeletion(deps(), {
            schoolId,
            userId: parent.id,
            memberId: parent.code!,
            password: "wrong-password",
          }),
        ),
      ).toBe(ERROR_CODES.ACCOUNT_DELETION_VERIFICATION_FAILED);
      expect((await accountState(parent.id)).due).toBeNull();

      // Never-changed accounts still have the default password; the member ID is case-insensitive.
      await scheduleAccountDeletion(deps(), {
        schoolId,
        userId: parent.id,
        memberId: ` ${parent.code!.toLowerCase()} `,
        password: "pass@1234",
      });
      expect((await accountState(parent.id)).due).not.toBeNull();
    },
  );

  integrationTest("the emailed-link path does not ask for member credentials", async () => {
    const parent = await seedUser(ROLES.PARENT);

    await scheduleAccountDeletion(deps(), {
      schoolId,
      userId: parent.id,
      source: "web_request",
    });

    expect((await accountState(parent.id)).due).not.toBeNull();
  });
});

describe("cancelAccountDeletion", () => {
  integrationTest("clears a scheduled deletion; a second cancel is a 409", async () => {
    const admin = await seedUser(ROLES.ORG_ADMIN);
    await scheduleAccountDeletion(deps(), { schoolId, userId: admin.id });

    await cancelAccountDeletion(database!.sql as never, { schoolId, userId: admin.id });

    expect((await accountState(admin.id)).due).toBeNull();
    expect(
      await codeOf(cancelAccountDeletion(database!.sql as never, { schoolId, userId: admin.id })),
    ).toBe(ERROR_CODES.ACCOUNT_DELETION_NOT_SCHEDULED);
  });
});
