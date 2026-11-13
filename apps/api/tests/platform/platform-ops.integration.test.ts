// Platform console operations against a real, migrated database: Studafy-wide banners, the staff
// activity log, system health and the cross-school flag view, plus the HTTP guards around them.

import { randomUUID } from "node:crypto";

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  listPlatformActivity,
  listPlatformOperators,
} from "../../src/modules/platform/ops/activity-service";
import {
  createAnnouncement,
  listActiveBanners,
  listAnnouncements,
  updateAnnouncement,
} from "../../src/modules/platform/ops/announcements-service";
import { listFlagsAcrossSchools } from "../../src/modules/platform/ops/flags-overview-service";
import { getSystemHealth } from "../../src/modules/platform/ops/health-service";
import { setSchoolFeatureFlag } from "../../src/modules/platform/service";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestApp,
  type TestDatabase,
} from "../harness";

import type { Database } from "../../src/db/client";
import type { Actor } from "../../src/modules/platform/service";

const integrationTest = test.skipIf(!integrationEnabled);
const HOUR = 60 * 60 * 1000;

let db: TestDatabase;
let home: string;
let alpha: string;
let beta: string;
let operatorId: string;
let teacherId: string;
let testApp: TestApp & { ready: Promise<void> };

function actor(): Actor {
  return { userId: operatorId, schoolId: home, requestId: randomUUID() };
}

function database(): Database {
  return db.sql as unknown as Database;
}

async function asAdminIn<T>(schoolId: string | null, fn: (tx: TestDatabase["sql"]) => Promise<T>) {
  return db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx as unknown as TestDatabase["sql"]);
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  home = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  alpha = (await createSchool(db.sql, { name: "Alpha Academy" })).id;
  beta = (await createSchool(db.sql, { name: "Beta School" })).id;
  const operator = await createUser(db.sql, home, {
    email: "ops@studafy.test",
    displayName: "Ops",
  });
  await assignRole(db.sql, home, operator.id, "SUPER_ADMIN");
  operatorId = operator.id;
  const teacher = await createUser(db.sql, alpha, { email: "t@alpha.test" });
  await assignRole(db.sql, alpha, teacher.id, "INSTRUCTOR");
  teacherId = teacher.id;
  testApp = createTestApp({ database: database() });
  await testApp.ready;
}, 120_000);

afterAll(async () => {
  if (!integrationEnabled) return;
  testApp.keyStore.destroy();
  await db.cleanup();
});

describe("announcements", () => {
  integrationTest("a live banner reaches its audience; staff-only skips parents", async () => {
    const now = new Date();
    const all = await createAnnouncement(
      database(),
      {
        messageEn: "Maintenance tonight",
        messageAr: "صيانة الليلة",
        audience: "all",
        severity: "maintenance",
        startsAt: new Date(now.getTime() - HOUR),
        endsAt: new Date(now.getTime() + HOUR),
        reason: "Database upgrade",
      },
      actor(),
    );
    const staff = await createAnnouncement(
      database(),
      {
        messageEn: "New report cards are live",
        messageAr: null,
        audience: "staff",
        severity: "info",
        startsAt: new Date(now.getTime() - HOUR),
        endsAt: new Date(now.getTime() + HOUR),
        reason: "Release note",
      },
      actor(),
    );
    expect(all.state).toBe("live");

    const forParent = await listActiveBanners(database(), [ROLES.PARENT]);
    expect(forParent.map((banner) => banner.id)).toContain(all.id);
    expect(forParent.map((banner) => banner.id)).not.toContain(staff.id);
    // Maintenance banners can't be dismissed and sort first.
    expect(forParent[0]).toMatchObject({
      id: all.id,
      dismissible: false,
      messageAr: "صيانة الليلة",
    });

    const forTeacher = await listActiveBanners(database(), [ROLES.INSTRUCTOR]);
    expect(forTeacher.map((banner) => banner.id)).toEqual(
      expect.arrayContaining([all.id, staff.id]),
    );
    expect(forTeacher.find((banner) => banner.id === staff.id)?.dismissible).toBe(true);

    // The audit row lives in the operator's home school, with the reason.
    const rows = await asAdminIn(
      home,
      (tx) =>
        tx<{ actor_id: string; new_values: Record<string, unknown> }[]>`
        SELECT actor_id, new_values FROM app.audit_logs
        WHERE target_table = 'platform_announcements' AND target_id = ${all.id}
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_id).toBe(operatorId);
    expect(rows[0]!.new_values.reason).toBe("Database upgrade");

    // Ending it early takes it off every screen and freezes it.
    const ended = await updateAnnouncement(
      database(),
      all.id,
      { endNow: true, reason: "Done early" },
      actor(),
    );
    expect(ended.state).toBe("ended");
    expect((await listActiveBanners(database(), [ROLES.PARENT])).map((b) => b.id)).not.toContain(
      all.id,
    );
    await expect(
      updateAnnouncement(database(), all.id, { messageEn: "Again", reason: "Edit" }, actor()),
    ).rejects.toMatchObject({ status: 409 });

    const listed = await listAnnouncements(database(), { limit: 10 });
    expect(listed.find((item) => item.id === all.id)?.state).toBe("ended");
    expect(listed.find((item) => item.id === staff.id)?.state).toBe("live");
  });

  integrationTest("a scheduled banner isn't shown yet, and a bad window is refused", async () => {
    const now = new Date();
    const later = await createAnnouncement(
      database(),
      {
        messageEn: "Coming soon",
        messageAr: null,
        audience: "all",
        severity: "warning",
        startsAt: new Date(now.getTime() + HOUR),
        endsAt: new Date(now.getTime() + 2 * HOUR),
        reason: "Heads-up",
      },
      actor(),
    );
    expect(later.state).toBe("scheduled");
    expect((await listActiveBanners(database(), [ROLES.STUDENT])).map((b) => b.id)).not.toContain(
      later.id,
    );
    await expect(
      createAnnouncement(
        database(),
        {
          messageEn: "Backwards",
          messageAr: null,
          audience: "all",
          severity: "info",
          startsAt: new Date(now.getTime() + 2 * HOUR),
          endsAt: new Date(now.getTime() + HOUR),
          reason: "Test",
        },
        actor(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("activity log", () => {
  integrationTest("lists operator actions with the school they changed", async () => {
    await setSchoolFeatureFlag(database(), null, alpha, "ai.llm", true, actor());
    await setSchoolFeatureFlag(database(), null, beta, "ai.rerank", true, actor());

    const all = await listPlatformActivity(database(), {
      from: new Date(Date.now() - 24 * HOUR),
      to: new Date(Date.now() + HOUR),
      limit: 50,
    });
    const flagRows = all.entries.filter((entry) => entry.targetTable === "feature_flags");
    expect(flagRows.map((entry) => entry.affectedSchool?.id).sort()).toEqual([alpha, beta].sort());
    expect(all.entries.every((entry) => entry.actor.userId === operatorId)).toBe(true);
    expect(all.entries.some((entry) => entry.targetTable === "platform_announcements")).toBe(true);

    const onlyAlpha = await listPlatformActivity(database(), {
      from: new Date(Date.now() - 24 * HOUR),
      to: new Date(Date.now() + HOUR),
      schoolId: alpha,
      limit: 50,
    });
    expect(onlyAlpha.entries).toHaveLength(1);
    expect(onlyAlpha.entries[0]).toMatchObject({
      targetTable: "feature_flags",
      affectedSchool: { id: alpha, name: "Alpha Academy" },
    });

    const inserts = await listPlatformActivity(database(), {
      from: new Date(Date.now() - 24 * HOUR),
      to: new Date(Date.now() + HOUR),
      action: "insert",
      limit: 50,
    });
    expect(inserts.entries.every((entry) => entry.action === "insert")).toBe(true);
    expect(inserts.entries.find((entry) => entry.reason === "Database upgrade")).toBeDefined();
  });

  integrationTest("pages with a cursor without repeating rows", async () => {
    const range = { from: new Date(Date.now() - 24 * HOUR), to: new Date(Date.now() + HOUR) };
    const first = await listPlatformActivity(database(), { ...range, limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await listPlatformActivity(database(), {
      ...range,
      limit: 2,
      cursor: first.nextCursor!,
    });
    const ids = new Set(first.entries.map((entry) => entry.id));
    expect(second.entries.some((entry) => ids.has(entry.id))).toBe(false);
  });

  integrationTest("lists Studafy staff accounts only", async () => {
    const operators = await listPlatformOperators(database());
    expect(operators.map((operator) => operator.userId)).toEqual([operatorId]);
    expect(operators[0]).toMatchObject({ homeSchoolId: home, roles: ["SUPER_ADMIN"] });
  });
});

describe("feature flags across schools", () => {
  integrationTest("shows each override and the deployment default", async () => {
    const flags = await listFlagsAcrossSchools(database(), null);
    const llm = flags.find((flag) => flag.name === "ai.llm")!;
    expect(llm.overrides).toEqual([
      expect.objectContaining({ schoolId: alpha, schoolName: "Alpha Academy", enabled: true }),
    ]);
    expect(llm.deploymentDefault).toBe(false);
    expect(llm.enabledSchools).toBe(1);
    expect(llm.totalSchools).toBe(3);
  });
});

describe("system health", () => {
  integrationTest("reads what is recorded and lists what isn't", async () => {
    await asAdminIn(alpha, async (tx) => {
      await tx`
        INSERT INTO app.notification_dead_letters (
          school_id, queue_name, job_id, job_name, attempts_made, error_class, error_message
        ) VALUES (${alpha}, 'notifications', 'job-1', 'dispatch', 5, 'Error', 'boom')
      `;
    });
    await asAdminIn(null, async (tx) => {
      await tx`
        INSERT INTO app.email_events (message_id, event_type, payload)
        VALUES ('m-1', 'bounce', '{}'::jsonb), ('m-2', 'complaint', '{}'::jsonb)
      `;
    });

    const health = await getSystemHealth(database(), null);
    expect(health.notificationDeadLetters.total).toBe(1);
    expect(health.notificationDeadLetters.bySchool[0]).toMatchObject({
      schoolId: alpha,
      count: 1,
    });
    expect(health.email).toMatchObject({ bounces: 1, complaints: 1 });
    // No Redis here: the job and storage sections say so instead of failing.
    expect(health.jobs.available).toBe(false);
    expect(health.storage.available).toBe(false);
    expect(health.notAvailable).toEqual(
      expect.arrayContaining(["background_jobs", "storage_report", "google_play_webhook_failures"]),
    );
  });
});

describe("HTTP", () => {
  integrationTest("the console needs a web session with platform permissions", async () => {
    const asTeacher = await authenticatedRequest(testApp, "GET", "/api/platform/health", {
      schoolId: alpha,
      userId: teacherId,
      roles: [ROLES.INSTRUCTOR],
      channel: AUTH_CHANNELS.WEB,
    });
    expect(asTeacher.status).toBe(403);

    const operatorOnMobile = await authenticatedRequest(testApp, "GET", "/api/platform/activity", {
      schoolId: home,
      userId: operatorId,
      roles: [ROLES.SUPER_ADMIN],
      channel: AUTH_CHANNELS.MOBILE,
    });
    expect(operatorOnMobile.status).toBe(403);

    const created = await authenticatedRequest(
      testApp,
      "POST",
      "/api/platform/announcements",
      {
        schoolId: home,
        userId: operatorId,
        roles: [ROLES.SUPER_ADMIN],
        channel: AUTH_CHANNELS.WEB,
      },
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageEn: "Hello schools",
          startsAt: new Date(Date.now() - HOUR).toISOString(),
          endsAt: new Date(Date.now() + HOUR).toISOString(),
          reason: "Welcome",
        }),
      },
    );
    expect(created.status).toBe(201);

    const missingReason = await authenticatedRequest(
      testApp,
      "POST",
      "/api/platform/announcements",
      {
        schoolId: home,
        userId: operatorId,
        roles: [ROLES.SUPER_ADMIN],
        channel: AUTH_CHANNELS.WEB,
      },
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageEn: "No reason",
          startsAt: new Date(Date.now() - HOUR).toISOString(),
          endsAt: new Date(Date.now() + HOUR).toISOString(),
        }),
      },
    );
    expect(missingReason.status).toBe(400);
  });

  integrationTest("any signed-in user reads live banners, on mobile too", async () => {
    const response = await authenticatedRequest(testApp, "GET", "/api/platform-banners", {
      schoolId: alpha,
      userId: teacherId,
      roles: [ROLES.INSTRUCTOR],
      channel: AUTH_CHANNELS.MOBILE,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { banners: { messageEn: string }[] };
    expect(body.banners.map((banner) => banner.messageEn)).toContain("Hello schools");
  });
});
