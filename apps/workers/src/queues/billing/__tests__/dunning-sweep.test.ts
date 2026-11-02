/**
 * The dunning sweep (ST-134), against a real database.
 *
 * Seeds subscriptions directly (a `grace_period` row with an explicit deadline) rather than driving
 * the state machine, because the machine's stamping path is covered by packages/billing's suite and
 * this file is about what the sweep does with rows that already exist: emit the reminder sequence,
 * advance the stored stage, and close expired windows through `applySystemTransition` -- which is
 * what the audit rows, entitlement invalidation and the AI cascade assertions below are really about.
 *
 * The clock is injected, so every case is deterministic: `now` is a fixed Date the seeding derives
 * its deadlines from, and the sweep never sees the wall clock. Skipped (as `skipIf` tests) unless
 * TEST_DATABASE_URL is set.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runDunningSweep } from "../dunning-sweep";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dunningTest = test.skipIf(!enabled);

let db: Sql | undefined;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DAY = 86_400_000;
const BASE = new Date("2026-01-01T00:00:00.000Z");
/** Fourteen days out from BASE: the school grace deadline the sweep's schedule reconstructs. */
const GRACE_DEADLINE = new Date(BASE.getTime() + 14 * DAY);
const PLAN_NAME = "Dunning Test Plan";

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

interface SeedOptions {
  /** The school subscription's state. Status `active` means no grace row exists. */
  subscription?: {
    status: string;
    gracePeriodEndsAt: string | null;
    dunningEmailStage?: number;
    currentPeriodStart: string;
    currentPeriodEnd: string;
  };
  /** How many ORG_ADMIN users (with their roles) to create. */
  admins?: number;
  aiSubscriptions?: { status: string; gracePeriodEndsAt: string | null }[];
}

interface Fixture {
  schoolId: string;
  subscriptionId: string | null;
  studentIds: string[];
  /** The ORG_ADMINs' normalized_email values, in seeding order. */
  adminEmails: string[];
}

async function seedFixture(options: SeedOptions): Promise<Fixture> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `dun-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Dunning School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, is_active)
      VALUES (${`plan_${slug.replaceAll("-", "_")}`}, ${PLAN_NAME}, true)
      RETURNING id
    `;

    let subscriptionId: string | null = null;
    if (options.subscription) {
      const sub = options.subscription;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.subscriptions (
          school_id, plan_id, status, current_period_start, current_period_end,
          grace_period_ends_at, dunning_email_stage
        ) VALUES (
          ${schoolId}::uuid, ${plan!.id}::uuid, ${sub.status}::app.subscription_status,
          ${sub.currentPeriodStart}::timestamptz, ${sub.currentPeriodEnd}::timestamptz,
          ${sub.gracePeriodEndsAt}::timestamptz, ${sub.dunningEmailStage ?? 0}
        )
        RETURNING id
      `;
      subscriptionId = row!.id;
    }

    const adminEmails: string[] = [];
    for (let i = 0; i < (options.admins ?? 0); i += 1) {
      const email = `admin${i}-${slug}@local`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, ${`Admin ${i}`}, 'active')
        RETURNING id
      `;
      await tx`
        INSERT INTO app.user_roles (school_id, user_id, role)
        VALUES (${schoolId}::uuid, ${user!.id}::uuid, 'ORG_ADMIN'::app.user_role)
      `;
      adminEmails.push(email);
    }

    const studentIds: string[] = [];
    for (const ai of options.aiSubscriptions ?? []) {
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (
          ${schoolId}::uuid, ${`ai-${crypto.randomUUID().slice(0, 8)}@local`},
          ${`ai-${crypto.randomUUID().slice(0, 8)}@local`}, 'AI Student', 'active'
        )
        RETURNING id
      `;
      const [student] = await tx<{ id: string }[]>`
        INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
        VALUES (
          ${schoolId}::uuid, ${user!.id}::uuid, ${`ADM-${slug}-${studentIds.length}`},
          'AI', 'Student', 'enrolled'
        )
        RETURNING id
      `;
      studentIds.push(student!.id);

      await tx`
        INSERT INTO app.ai_subscriptions (
          school_id, student_id, status, current_period_start, current_period_end, grace_period_ends_at
        ) VALUES (
          ${schoolId}::uuid, ${student!.id}::uuid, ${ai.status}::app.subscription_status,
          ${BASE.toISOString()}::timestamptz, ${new Date(BASE.getTime() + 30 * DAY).toISOString()}::timestamptz,
          ${ai.gracePeriodEndsAt}::timestamptz
        )
      `;
    }

    return { schoolId, subscriptionId, studentIds, adminEmails };
  });
}

interface OutboxRow {
  eventName: string;
  payload: Record<string, unknown>;
}

async function readOutbox(schoolId: string): Promise<OutboxRow[]> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const rows = await tx<{ event_name: string; payload: unknown }[]>`
      SELECT event_name, payload FROM app.outbox_events WHERE school_id = ${schoolId}::uuid
    `;
    return rows.map((r) => ({
      eventName: r.event_name,
      payload: r.payload as Record<string, unknown>,
    }));
  });
}

interface AuditRow {
  targetTable: string;
  targetId: string;
  oldValues: { status?: string };
  newValues: { status?: string };
}

async function readAuditRows(schoolId: string): Promise<AuditRow[]> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const rows = await tx<
      { target_table: string; target_id: string; old_values: unknown; new_values: unknown }[]
    >`
      SELECT target_table, target_id::text AS target_id, old_values, new_values
      FROM app.audit_logs
      WHERE target_table IN ('subscriptions', 'ai_subscriptions')
      ORDER BY created_at
    `;
    return rows.map((r) => ({
      targetTable: r.target_table,
      targetId: r.target_id,
      oldValues: (r.old_values ?? {}) as { status?: string },
      newValues: (r.new_values ?? {}) as { status?: string },
    }));
  });
}

async function readSubscription(
  schoolId: string,
  subscriptionId: string,
): Promise<{ status: string; gracePeriodEndsAt: string | null; dunningEmailStage: number }> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<
      { status: string; grace_period_ends_at: string | null; dunning_email_stage: number }[]
    >`
      SELECT status::text AS status, grace_period_ends_at::text AS grace_period_ends_at,
             dunning_email_stage
      FROM app.subscriptions WHERE id = ${subscriptionId}::uuid
    `;
    return {
      status: row!.status,
      gracePeriodEndsAt: row!.grace_period_ends_at,
      dunningEmailStage: row!.dunning_email_stage,
    };
  });
}

async function readAiStatuses(schoolId: string): Promise<string[]> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const rows = await tx<{ status: string }[]>`
      SELECT status::text AS status FROM app.ai_subscriptions
      WHERE school_id = ${schoolId}::uuid ORDER BY created_at
    `;
    return rows.map((r) => r.status);
  });
}

async function readEntitlementVersion(
  schoolId: string,
  subjectType: "school" | "ai",
  subjectId: string,
): Promise<number | null> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ version: string | null }[]>`
      SELECT version::text AS version FROM app.entitlement_versions
      WHERE school_id = ${schoolId}::uuid
        AND subject_type = ${subjectType}::app.entitlement_subject
        AND subject_id = ${subjectId}::uuid
    `;
    return row?.version !== null && row?.version !== undefined ? Number(row.version) : null;
  });
}

/** A grace-window shape used by several cases: deadline 14 days out, due today. */
const SCHOOL_GRACE = {
  status: "grace_period",
  gracePeriodEndsAt: GRACE_DEADLINE.toISOString(),
  currentPeriodStart: new Date(BASE.getTime() - 30 * DAY).toISOString(),
  currentPeriodEnd: BASE.toISOString(),
};

describe("dunning sweep", () => {
  dunningTest("queues the due reminder for each ORG_ADMIN and advances the stage", async () => {
    const { schoolId, subscriptionId, adminEmails } = await seedFixture({
      subscription: SCHOOL_GRACE,
      admins: 2,
    });
    const now = new Date(BASE.getTime() + 7 * DAY + 3_600_000);

    // The sweep is global -- it enumerates every school in the database -- so counts like
    // `result.emails` include other fixtures' rows. Assertions are therefore per-school: our school's
    // outbox, stage and status. (The webhook and invalidator suites follow the same disposable-DB,
    // per-school-assertion convention.)
    const result = await runDunningSweep(db!, now, silentLogger);
    expect(result.schools).toBeGreaterThan(0);

    const outbox = await readOutbox(schoolId);
    expect(outbox).toHaveLength(2);
    for (const row of outbox) {
      expect(row.eventName).toBe(DOMAIN_EVENTS.SUBSCRIPTION_DUNNING_SENT);
      expect(row.payload).toMatchObject({
        schoolId,
        subscriptionId,
        planName: PLAN_NAME,
        dueDate: BASE.toISOString(),
        gracePeriodEndsAt: GRACE_DEADLINE.toISOString(),
      });
    }
    expect(new Set(outbox.map((r) => r.payload.email))).toEqual(new Set(adminEmails));

    const sub = await readSubscription(schoolId, subscriptionId!);
    expect(sub.status).toBe("grace_period");
    expect(sub.dunningEmailStage).toBe(2);

    // A re-run with the same clock is a no-op: the stored stage already covers the due day.
    await runDunningSweep(db!, now, silentLogger);
    expect(await readOutbox(schoolId)).toHaveLength(2);
  });

  dunningTest(
    "no ORG_ADMIN still advances the stage, so the sequence is not queued late",
    async () => {
      const { schoolId, subscriptionId } = await seedFixture({
        subscription: SCHOOL_GRACE,
        admins: 0,
      });

      await runDunningSweep(db!, new Date(BASE.getTime() + 7 * DAY + 3_600_000), silentLogger);

      expect(await readOutbox(schoolId)).toHaveLength(0);
      const sub = await readSubscription(schoolId, subscriptionId!);
      expect(sub.dunningEmailStage).toBe(2);
    },
  );

  dunningTest("a subscription before its first reminder is left alone", async () => {
    const { schoolId, subscriptionId } = await seedFixture({
      subscription: SCHOOL_GRACE,
      admins: 2,
    });

    await runDunningSweep(db!, new Date(BASE.getTime() + 3_600_000), silentLogger);

    expect(await readOutbox(schoolId)).toHaveLength(0);
    const sub = await readSubscription(schoolId, subscriptionId!);
    expect(sub.status).toBe("grace_period");
    expect(sub.dunningEmailStage).toBe(0);
  });

  dunningTest(
    "an expired school window closes the subscription, cascades to live AI rows, and is idempotent",
    async () => {
      const { schoolId, subscriptionId, studentIds } = await seedFixture({
        subscription: SCHOOL_GRACE,
        admins: 2,
        aiSubscriptions: [
          { status: "active", gracePeriodEndsAt: null },
          {
            status: "grace_period",
            gracePeriodEndsAt: new Date(BASE.getTime() + 7 * DAY).toISOString(),
          },
        ],
      });
      const now = new Date(GRACE_DEADLINE.getTime() + 3_600_000);

      await runDunningSweep(db!, now, silentLogger);

      const sub = await readSubscription(schoolId, subscriptionId!);
      expect(sub.status).toBe("closed");
      expect(sub.gracePeriodEndsAt).toBeNull();
      expect(sub.dunningEmailStage).toBe(0);

      expect(await readAiStatuses(schoolId)).toEqual(["closed", "closed"]);

      const audit = await readAuditRows(schoolId);
      expect(audit).toHaveLength(3);
      expect(audit.map((r) => [r.targetTable, r.oldValues.status, r.newValues.status])).toEqual(
        expect.arrayContaining([
          ["subscriptions", "grace_period", "closed"],
          ["ai_subscriptions", "active", "closed"],
          ["ai_subscriptions", "grace_period", "closed"],
        ]),
      );

      const outbox = await readOutbox(schoolId);
      const statusChanges = outbox.filter(
        (r) => r.eventName !== DOMAIN_EVENTS.SUBSCRIPTION_DUNNING_SENT,
      );
      expect(statusChanges).toHaveLength(3);
      expect(
        statusChanges.filter((r) => r.eventName === DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED),
      ).toHaveLength(1);
      expect(
        statusChanges.filter((r) => r.eventName === DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED),
      ).toHaveLength(2);

      expect(await readEntitlementVersion(schoolId, "school", schoolId)).toBe(2);
      for (const studentId of studentIds) {
        expect(await readEntitlementVersion(schoolId, "ai", studentId)).toBe(2);
      }

      // Idempotency: the same clock re-applied transitions nothing and writes nothing new.
      await runDunningSweep(db!, now, silentLogger);
      expect(await readAuditRows(schoolId)).toHaveLength(3);
      expect(await readOutbox(schoolId)).toHaveLength(3);
    },
  );

  dunningTest(
    "an expired AI window closes through the sweep's own transition, school untouched",
    async () => {
      const { schoolId, studentIds } = await seedFixture({
        subscription: { ...SCHOOL_GRACE, dunningEmailStage: 4 },
        aiSubscriptions: [
          {
            status: "grace_period",
            gracePeriodEndsAt: new Date(BASE.getTime() + 2 * DAY).toISOString(),
          },
        ],
      });
      const now = new Date(BASE.getTime() + 5 * DAY);

      await runDunningSweep(db!, now, silentLogger);

      expect(await readAiStatuses(schoolId)).toEqual(["closed"]);
      expect(await readEntitlementVersion(schoolId, "ai", studentIds[0]!)).toBe(2);

      const audit = await readAuditRows(schoolId);
      expect(audit).toHaveLength(1);
      expect(audit[0]!).toEqual({
        targetTable: "ai_subscriptions",
        targetId: expect.any(String),
        oldValues: { status: "grace_period" },
        newValues: { status: "closed" },
      });

      const outbox = await readOutbox(schoolId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.eventName).toBe(DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED);
    },
  );
});
