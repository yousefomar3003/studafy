/**
 * Notification preferences HTTP tests (ST-143).
 *
 * Exercises the full HTTP path — JWT auth, route validation, tenant transaction with RLS armed — for
 * GET/PATCH /api/notification-preferences. Requires a live PostgreSQL instance, gated on
 * TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/notifications/preferences-http.test.ts
 */

import { NOTIFICATION_TYPES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser as createUserFactory,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

interface PreferenceCell {
  notification_type: string;
  channel: string;
  enabled: boolean;
  digest: boolean;
  mandatory: boolean;
  digest_eligible: boolean;
}
interface PreferencesResponse {
  preferences: PreferenceCell[];
  attendance_alert_threshold: number | null;
}

/** RequestInit for a JSON body. authenticatedRequest's own `method` argument sets the verb. */
function jsonBody(body: unknown): { headers: Record<string, string>; body: string } {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function cell(res: PreferencesResponse, type: string, channel: string): PreferenceCell {
  const found = res.preferences.find((p) => p.notification_type === type && p.channel === channel);
  if (!found) throw new Error(`no cell for ${type}/${channel}`);
  return found;
}

describeDb("notification preferences HTTP", () => {
  test("GET returns the seeded default matrix", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);

    const res = await authenticatedRequest(harness!, "GET", "/api/notification-preferences", {
      schoolId: school.id,
      userId: user.id,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as PreferencesResponse;
    expect(body.attendance_alert_threshold).toBeNull();
    expect(cell(body, NOTIFICATION_TYPES.GRADE_POSTED, "email").enabled).toBe(true);
    expect(cell(body, NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT, "email").mandatory).toBe(true);
    expect(cell(body, NOTIFICATION_TYPES.DISCUSSION_REPLY, "email").digest_eligible).toBe(true);
  });

  test("PATCH toggles a channel and it sticks on the next GET", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);

    const patchRes = await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: school.id, userId: user.id },
      jsonBody({
        preferences: [
          { notification_type: NOTIFICATION_TYPES.GRADE_POSTED, channel: "email", enabled: false },
        ],
      }),
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as PreferencesResponse;
    expect(cell(patched, NOTIFICATION_TYPES.GRADE_POSTED, "email").enabled).toBe(false);

    const getRes = await authenticatedRequest(harness!, "GET", "/api/notification-preferences", {
      schoolId: school.id,
      userId: user.id,
    });
    const body = (await getRes.json()) as PreferencesResponse;
    expect(cell(body, NOTIFICATION_TYPES.GRADE_POSTED, "email").enabled).toBe(false);
  });

  test("PATCH rejects disabling a mandatory type with 422", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);

    const res = await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: school.id, userId: user.id },
      jsonBody({
        preferences: [
          {
            notification_type: NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT,
            channel: "push",
            enabled: false,
          },
        ],
      }),
    );

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
  });

  test("PATCH rejects digest on a non-email channel with 422", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);

    const res = await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: school.id, userId: user.id },
      jsonBody({
        preferences: [
          { notification_type: NOTIFICATION_TYPES.DISCUSSION_REPLY, channel: "push", digest: true },
        ],
      }),
    );

    expect(res.status).toBe(422);
  });

  test("PATCH sets and clears the attendance-alert threshold", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);

    const setRes = await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: school.id, userId: user.id },
      jsonBody({ attendance_alert_threshold: 5 }),
    );
    expect(setRes.status).toBe(200);
    expect(((await setRes.json()) as PreferencesResponse).attendance_alert_threshold).toBe(5);

    const clearRes = await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: school.id, userId: user.id },
      jsonBody({ attendance_alert_threshold: null }),
    );
    expect(clearRes.status).toBe(200);
    expect(((await clearRes.json()) as PreferencesResponse).attendance_alert_threshold).toBeNull();
  });

  test("PATCH rejects a threshold outside 1-365 with 400", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);

    const res = await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: school.id, userId: user.id },
      jsonBody({ attendance_alert_threshold: 0 }),
    );

    expect(res.status).toBe(400);
  });

  test("PATCH rejects an empty body with 400", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);

    const res = await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: school.id, userId: user.id },
      jsonBody({}),
    );

    expect(res.status).toBe(400);
  });

  test("cannot see or change another user's preferences", async () => {
    const school = await createSchool(database!.sql);
    const owner = await createUserFactory(database!.sql, school.id);
    const other = await createUserFactory(database!.sql, school.id);

    await authenticatedRequest(
      harness!,
      "PATCH",
      "/api/notification-preferences",
      { schoolId: school.id, userId: owner.id },
      jsonBody({
        preferences: [
          { notification_type: NOTIFICATION_TYPES.GRADE_POSTED, channel: "email", enabled: false },
        ],
      }),
    );

    const res = await authenticatedRequest(harness!, "GET", "/api/notification-preferences", {
      schoolId: school.id,
      userId: other.id,
    });
    const body = (await res.json()) as PreferencesResponse;
    expect(cell(body, NOTIFICATION_TYPES.GRADE_POSTED, "email").enabled).toBe(true);
  });

  test("requires authentication", async () => {
    const res = await harness!.app.request("/api/notification-preferences");
    expect(res.status).toBe(401);
  });
});

describeDb("quiet hours and the test notification", () => {
  test("quiet hours are off by default, can be set, and cleared", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);
    const auth = { schoolId: school.id, userId: user.id };
    const path = "/api/notification-preferences/quiet-hours";

    const initial = await authenticatedRequest(harness!, "GET", path, auth);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ start: null, end: null });

    const set = await authenticatedRequest(
      harness!,
      "PUT",
      path,
      auth,
      jsonBody({ start: "22:00", end: "06:30" }),
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ start: "22:00", end: "06:30" });

    const cleared = await authenticatedRequest(
      harness!,
      "PUT",
      path,
      auth,
      jsonBody({ start: null, end: null }),
    );
    expect(await cleared.json()).toMatchObject({ start: null, end: null });
  });

  test("half a window or a malformed time is refused", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);
    const auth = { schoolId: school.id, userId: user.id };
    const path = "/api/notification-preferences/quiet-hours";

    for (const body of [
      { start: "22:00", end: null },
      { start: "25:00", end: "06:00" },
    ]) {
      const res = await authenticatedRequest(harness!, "PUT", path, auth, jsonBody(body));
      expect(res.status).toBe(400);
    }
  });

  test("the test button adds a test notice to the caller's inbox, at most every 20 seconds", async () => {
    const school = await createSchool(database!.sql);
    const user = await createUserFactory(database!.sql, school.id);
    const auth = { schoolId: school.id, userId: user.id };

    const first = await authenticatedRequest(harness!, "POST", "/api/notifications/test", auth);
    expect(first.status).toBe(201);
    const { notification_id } = (await first.json()) as { notification_id: string };

    const [row] = await database!.sql<{ user_id: string; test: string }[]>`
      SELECT user_id, metadata ->> 'test' AS test FROM app.notifications
      WHERE id = ${notification_id}::uuid
    `;
    expect(row).toEqual({ user_id: user.id, test: "true" });

    const again = await authenticatedRequest(harness!, "POST", "/api/notifications/test", auth);
    expect(again.status).toBe(429);
  });
});
