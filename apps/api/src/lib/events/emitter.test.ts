import { resolve } from "node:path";

import { DOMAIN_EVENTS, type DomainEvent } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runMigrationCommand } from "../../../../../packages/db/src/runner";
import {
  integrationEnabled,
  runnerEnv,
  testDatabase,
} from "../../../../../packages/db/tests/helpers";

import { emit } from "./emitter";
import { eventPayloadSchemas } from "./schemas";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../../../db/migrations");

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

// ── Schema coverage ────────────────────────────────────────────────────────

describe("eventPayloadSchemas", () => {
  test("has a schema for every DOMAIN_EVENTS value", () => {
    const allEvents = Object.values(DOMAIN_EVENTS);
    const schemaKeys = Object.keys(eventPayloadSchemas);

    expect(schemaKeys).toHaveLength(allEvents.length);

    for (const event of allEvents) {
      expect(eventPayloadSchemas[event]).toBeDefined();
    }
  });

  test("rejects invalid payloads for single-id events", () => {
    const schema = eventPayloadSchemas[DOMAIN_EVENTS.USER_CREATED];
    expect(() => schema.parse({ userId: "not-a-uuid" })).toThrow();
  });

  test("accepts valid payloads for single-id events", () => {
    const schema = eventPayloadSchemas[DOMAIN_EVENTS.USER_CREATED];
    const result = schema.parse({ userId: crypto.randomUUID() });
    expect(result).toEqual({ userId: expect.any(String) });
  });

  test("rejects invalid payloads for multi-id events", () => {
    const schema = eventPayloadSchemas[DOMAIN_EVENTS.ENROLLMENT_CREATED];
    expect(() =>
      schema.parse({
        enrollmentId: crypto.randomUUID(),
        courseId: "not-a-uuid",
        studentId: crypto.randomUUID(),
      }),
    ).toThrow();
  });

  test("accepts valid payloads for multi-id events", () => {
    const schema = eventPayloadSchemas[DOMAIN_EVENTS.SUBMISSION_GRADED];
    const result = schema.parse({
      submissionId: crypto.randomUUID(),
      assignmentId: crypto.randomUUID(),
      studentId: crypto.randomUUID(),
    });
    expect(result).toEqual({
      submissionId: expect.any(String),
      assignmentId: expect.any(String),
      studentId: expect.any(String),
    });
  });

  test("erpnext schemas accept arbitrary record payloads", () => {
    const schema = eventPayloadSchemas[DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED];
    const result = schema.parse({ grand_total: 100, name: "INV-001", custom_school_id: "x" });
    expect(result).toEqual({ grand_total: 100, name: "INV-001", custom_school_id: "x" });
  });
});

// ── Emit integration tests ─────────────────────────────────────────────────

describe("emit", () => {
  integrationTest("inserts a row into outbox_events inside a transaction", async () => {
    const schoolId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const event = DOMAIN_EVENTS.USER_CREATED;

    await database!.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
      await emit(tx, event, { userId });
    });

    const [row] = await database!.sql`
      SELECT event_name, payload
      FROM app.outbox_events
      WHERE school_id = ${schoolId}
    `;
    expect(row).toBeDefined();
    expect(row!.event_name).toBe(event);
    expect(row!.payload).toEqual({ userId });
  });

  integrationTest("throws when app.school_id GUC is not set", async () => {
    const userId = crypto.randomUUID();

    await expect(
      database!.sql.begin(async (tx) => {
        await emit(tx, DOMAIN_EVENTS.USER_CREATED, { userId });
      }),
    ).rejects.toThrow();
  });

  integrationTest("throws on invalid payload", async () => {
    const schoolId = crypto.randomUUID();

    await expect(
      database!.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
        await emit(tx, DOMAIN_EVENTS.USER_CREATED, { userId: "bad" } as never);
      }),
    ).rejects.toThrow();
  });

  integrationTest(
    "emits every event name without throwing",
    async () => {
      const schoolId = crypto.randomUUID();
      const uid = crypto.randomUUID();

      const payloads: Record<DomainEvent, unknown> = {
        [DOMAIN_EVENTS.USER_CREATED]: { userId: uid },
        [DOMAIN_EVENTS.USER_SUSPENDED]: { userId: uid },
        [DOMAIN_EVENTS.USER_INVITED]: { userId: uid },
        [DOMAIN_EVENTS.INVITATION_SENT]: {
          invitationId: uid,
          email: "test@example.com",
          role: "STUDENT",
          expiresAt: new Date().toISOString(),
          invitedByUserId: uid,
        },
        [DOMAIN_EVENTS.INVITATION_REVOKED]: {
          invitationId: uid,
          email: "test@example.com",
          role: "STUDENT",
        },
        [DOMAIN_EVENTS.SCHOOL_REGISTERED]: {
          schoolId: uid,
          adminUserId: uid,
          email: "test@example.com",
          slug: "test-school",
        },
        [DOMAIN_EVENTS.SCHOOL_VERIFICATION_EMAIL_SENT]: {
          schoolId: uid,
          email: "test@example.com",
          expiresAt: new Date().toISOString(),
        },
        [DOMAIN_EVENTS.SCHOOL_EMAIL_VERIFIED]: {
          schoolId: uid,
          email: "test@example.com",
          slug: "test-school",
        },
        [DOMAIN_EVENTS.ORGANIZATION_CREATED]: { organizationId: uid },
        [DOMAIN_EVENTS.ORGANIZATION_UPDATED]: { organizationId: uid },
        [DOMAIN_EVENTS.COURSE_CREATED]: { courseId: uid },
        [DOMAIN_EVENTS.COURSE_PUBLISHED]: { courseId: uid },
        [DOMAIN_EVENTS.COURSE_ARCHIVED]: { courseId: uid },
        [DOMAIN_EVENTS.ENROLLMENT_CREATED]: {
          enrollmentId: uid,
          courseId: uid,
          studentId: uid,
        },
        [DOMAIN_EVENTS.ENROLLMENT_APPROVED]: {
          enrollmentId: uid,
          courseId: uid,
          studentId: uid,
        },
        [DOMAIN_EVENTS.ENROLLMENT_CANCELLED]: {
          enrollmentId: uid,
          courseId: uid,
          studentId: uid,
        },
        [DOMAIN_EVENTS.ASSIGNMENT_PUBLISHED]: { assignmentId: uid, courseId: uid },
        [DOMAIN_EVENTS.ASSIGNMENT_DEADLINE_EXTENDED]: { assignmentId: uid, courseId: uid },
        [DOMAIN_EVENTS.SUBMISSION_CREATED]: {
          submissionId: uid,
          assignmentId: uid,
          studentId: uid,
        },
        [DOMAIN_EVENTS.SUBMISSION_GRADED]: {
          submissionId: uid,
          assignmentId: uid,
          studentId: uid,
        },
        [DOMAIN_EVENTS.SUBMISSION_RESUBMISSION_REQUESTED]: {
          submissionId: uid,
          assignmentId: uid,
          studentId: uid,
        },
        [DOMAIN_EVENTS.DISCUSSION_POSTED]: { discussionId: uid },
        [DOMAIN_EVENTS.DISCUSSION_MODERATED]: { discussionId: uid },
        [DOMAIN_EVENTS.STUDY_GROUP_CREATED]: { groupId: uid },
        [DOMAIN_EVENTS.STUDY_GROUP_JOINED]: { groupId: uid },
        [DOMAIN_EVENTS.CERTIFICATE_ISSUED]: { certificateId: uid, studentId: uid },
        [DOMAIN_EVENTS.CERTIFICATE_REVOKED]: { certificateId: uid, studentId: uid },
        [DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED]: { name: "INV-001" },
        [DOMAIN_EVENTS.ERPNEXT_FEE_DUE]: { name: "FEE-001" },
        [DOMAIN_EVENTS.ERPNEXT_PAYMENT_RECEIVED]: { name: "PAY-001" },
        [DOMAIN_EVENTS.ERPNEXT_CREDIT_NOTE_ISSUED]: { name: "CN-001" },
      };

      await database!.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

        for (const [event, payload] of Object.entries(payloads) as [DomainEvent, unknown][]) {
          await emit(tx, event, payload as never);
        }
      });

      const rows = await database!.sql`
        SELECT event_name FROM app.outbox_events WHERE school_id = ${schoolId}
      `;
      const emitted = rows.map((r) => r.event_name).sort();
      const expected = Object.values(DOMAIN_EVENTS).sort();
      expect(emitted).toEqual(expected);
    },
    30_000,
  );
});
