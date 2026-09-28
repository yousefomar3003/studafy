/**
 * Self-service account deletion against a real database: what changes immediately, what is
 * queued, and that a failure before commit leaves the account exactly as it was.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */

import { JOB_NAMES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  createRefreshSession,
  createSchool,
  createStudent,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { deleteAccount } from "../account-deletion-service";

import type { TestDatabase } from "../../../../tests/harness";
import type { PaymentProviderPort } from "../../subscriptions/ports/payment-provider";
import type { AccountDeletionDeps } from "../account-deletion-service";
import type { Queue } from "bullmq";
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

/** A signed-in student with a Microsoft identity, a live session and an AI subscription. */
async function seedStudent(billing: "stripe" | "tap") {
  const sql = database!.sql;
  const student = await createStudent(sql, schoolId);
  await assignRole(sql, schoolId, student.userId, ROLES.STUDENT);
  const session = await createRefreshSession(sql, schoolId, student.userId);
  await asAdmin(sql, async (tx) => {
    await tx`
      INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
      VALUES (${schoolId}, ${student.userId}, 'microsoft', ${crypto.randomUUID()})
    `;
    await tx`
      INSERT INTO app.ai_subscriptions
        (school_id, student_id, status, current_period_start, current_period_end,
         stripe_subscription_id, tap_card_id, tap_payment_agreement_id)
      VALUES (
        ${schoolId}, ${student.id}, 'active', now() - interval '1 day', now() + interval '29 days',
        ${billing === "stripe" ? `sub_${student.id}` : null},
        ${billing === "tap" ? "card_1" : null},
        ${billing === "tap" ? "agreement_1" : null}
      )
    `;
  });
  return { ...student, session };
}

function fakeDeps(options: { failEnqueue?: boolean } = {}) {
  const stripeCalls: string[] = [];
  const jobs: { name: string; data: unknown; jobId: unknown }[] = [];
  const deps: AccountDeletionDeps = {
    database: database!.sql as never,
    denylist: null,
    paymentProviders: {
      stripe: {
        async scheduleCancellation(input: { providerSubscriptionId: string }) {
          stripeCalls.push(input.providerSubscriptionId);
        },
      } as unknown as PaymentProviderPort,
      tap: null,
    },
    maintenanceQueue: {
      async add(name: string, data: unknown, opts: { jobId?: string }) {
        if (options.failEnqueue) throw new Error("redis down");
        jobs.push({ name, data, jobId: opts.jobId });
      },
    } as unknown as Queue,
    siwa: null,
  };
  return { deps, stripeCalls, jobs };
}

async function accountState(userId: string, studentId: string) {
  return asAdmin(database!.sql, async (tx) => {
    const [row] = await tx<
      {
        status: string;
        roles: number;
        identities: number;
        live_sessions: number;
        erasure_requests: number;
        tap_card_id: string | null;
      }[]
    >`
      SELECT
        (SELECT status::text FROM app.users WHERE id = ${userId}) AS status,
        (SELECT count(*)::int FROM app.user_roles WHERE user_id = ${userId}) AS roles,
        (SELECT count(*)::int FROM app.oauth_identities WHERE user_id = ${userId}) AS identities,
        (SELECT count(*)::int FROM app.refresh_tokens WHERE user_id = ${userId} AND revoked_at IS NULL) AS live_sessions,
        (SELECT count(*)::int FROM app.data_subject_requests
          WHERE subject_user_id = ${userId} AND request_type = 'erasure') AS erasure_requests,
        (SELECT tap_card_id FROM app.ai_subscriptions WHERE student_id = ${studentId}) AS tap_card_id
    `;
    return row!;
  });
}

describe("deleteAccount", () => {
  integrationTest(
    "detaches, stops Stripe billing, audits, queues erasure and signs out",
    async () => {
      const student = await seedStudent("stripe");
      const { deps, stripeCalls, jobs } = fakeDeps();

      const result = await deleteAccount(deps, { schoolId, userId: student.userId });

      expect(await accountState(student.userId, student.id)).toMatchObject({
        status: "archived",
        roles: 0,
        identities: 0,
        live_sessions: 0,
        erasure_requests: 1,
      });
      expect(stripeCalls).toEqual([`sub_${student.id}`]);
      expect(result.aiSubscriptionsCanceled).toBe(1);
      expect(result.request.status).toBe("queued");
      expect(result.request.slaDueAt.getTime()).toBeGreaterThan(Date.now());
      expect(jobs).toEqual([
        {
          name: JOB_NAMES.RUN_DATA_SUBJECT_ERASURE,
          data: { requestId: result.request.id, schoolId },
          jobId: result.request.id,
        },
      ]);

      const audit = await asAdmin(
        database!.sql,
        (tx) =>
          tx<{ new_values: Record<string, unknown> }[]>`
        SELECT new_values FROM app.audit_logs
        WHERE target_table = 'users' AND target_id = ${student.userId}::uuid AND action = 'delete'
      `,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.new_values).toMatchObject({
        reason: "account_deletion",
        data_subject_request_id: result.request.id,
        ai_subscriptions_canceled: 1,
        retained_record_categories: [
          "academic_grades",
          "attendance",
          "financial_records",
          "audit_log",
        ],
      });
    },
  );

  integrationTest("stops Tap billing by dropping the saved card", async () => {
    const student = await seedStudent("tap");
    const { deps, stripeCalls } = fakeDeps();

    await deleteAccount(deps, { schoolId, userId: student.userId });

    expect((await accountState(student.userId, student.id)).tap_card_id).toBeNull();
    expect(stripeCalls).toEqual([]);
  });

  integrationTest("a second request while erasure is pending is a 409", async () => {
    const student = await seedStudent("tap");
    await deleteAccount(fakeDeps().deps, { schoolId, userId: student.userId });

    const error = await deleteAccount(fakeDeps().deps, { schoolId, userId: student.userId }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CodedHttpException);
    expect((error as CodedHttpException).status).toBe(409);
  });

  integrationTest(
    "a queue failure rolls everything back and leaves the user signed in",
    async () => {
      const student = await seedStudent("tap");

      await expect(
        deleteAccount(fakeDeps({ failEnqueue: true }).deps, { schoolId, userId: student.userId }),
      ).rejects.toThrow("redis down");

      expect(await accountState(student.userId, student.id)).toMatchObject({
        status: "active",
        roles: 1,
        identities: 1,
        live_sessions: 1,
        erasure_requests: 0,
        tap_card_id: "card_1",
      });
    },
  );
});
