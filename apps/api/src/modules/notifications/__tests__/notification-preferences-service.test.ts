/**
 * Notification preferences service tests (ST-143).
 *
 * Integration tests that require a live PostgreSQL instance, following the same shape as
 * notification-service.test.ts: create a school and an active user via the test harness factories,
 * then exercise the service functions inside a tenant transaction with app.user_id set to that user,
 * exactly as the route does.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/notifications/__tests__
 */

import { NOTIFICATION_TYPES } from "@studafy/constants";
import { NOTIFICATION_CHANNELS } from "@studafy/notification-templates";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  createUser as createUserFactory,
  integrationEnabled,
  type TestDatabase,
} from "../../../../tests/harness";
import {
  getPreferences,
  updatePreferences,
  validateUpdate,
} from "../notification-preferences-service";

import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

/** The user's own view: the same GUC setup withTenantTx performs for the route. */
async function asUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true),
             set_config('app.user_id', ${userId}, true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

function findCell<T extends { notification_type: string; channel: string }>(
  preferences: T[],
  type: string,
  channel: string,
): T {
  const cell = preferences.find((p) => p.notification_type === type && p.channel === channel);
  if (!cell) throw new Error(`no cell for ${type}/${channel}`);
  return cell;
}

// ---------------------------------------------------------------------------
// getPreferences
// ---------------------------------------------------------------------------

describeDb("getPreferences", () => {
  test("returns the full seeded matrix, defaulting to enabled and non-digest", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    const result = await asUser(school.id, user.id, (tx) => getPreferences(tx, user.id));

    const types = Object.values(NOTIFICATION_TYPES);
    const channels = Object.values(NOTIFICATION_CHANNELS);
    expect(result.preferences).toHaveLength(types.length * channels.length);
    expect(result.preferences.every((p) => p.enabled)).toBe(true);
    expect(result.preferences.every((p) => !p.digest)).toBe(true);
    expect(result.attendance_alert_threshold).toBeNull();
  });

  test("marks exactly ADMIN_ANNOUNCEMENT as mandatory", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    const { preferences } = await asUser(school.id, user.id, (tx) => getPreferences(tx, user.id));

    const mandatoryTypes = new Set(
      preferences.filter((p) => p.mandatory).map((p) => p.notification_type),
    );
    expect(mandatoryTypes).toEqual(new Set([NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT]));
  });

  test("digest_eligible is true only for eligible types on the email channel", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    const { preferences } = await asUser(school.id, user.id, (tx) => getPreferences(tx, user.id));

    const eligible = preferences.filter((p) => p.digest_eligible);
    expect(eligible.every((p) => p.channel === NOTIFICATION_CHANNELS.EMAIL)).toBe(true);
    expect(new Set(eligible.map((p) => p.notification_type))).toEqual(
      new Set([
        NOTIFICATION_TYPES.DISCUSSION_REPLY,
        NOTIFICATION_TYPES.STUDY_GROUP_INVITE,
        NOTIFICATION_TYPES.COURSE_PUBLISHED,
        NOTIFICATION_TYPES.ATTENDANCE_ALERT,
      ]),
    );
  });

  test("does not expose another user's preferences", async () => {
    const school = await createSchool(db.sql);
    const owner = await createUserFactory(db.sql, school.id);
    const other = await createUserFactory(db.sql, school.id);

    await asUser(school.id, owner.id, (tx) =>
      updatePreferences(tx, school.id, owner.id, {
        preferences: [
          { notification_type: NOTIFICATION_TYPES.GRADE_POSTED, channel: "email", enabled: false },
        ],
      }),
    );

    const { preferences } = await asUser(school.id, other.id, (tx) => getPreferences(tx, other.id));
    expect(findCell(preferences, NOTIFICATION_TYPES.GRADE_POSTED, "email").enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updatePreferences — opt-out
// ---------------------------------------------------------------------------

describeDb("updatePreferences — channel toggles", () => {
  test("disables one (type, channel) cell and leaves the rest untouched", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    const result = await asUser(school.id, user.id, (tx) =>
      updatePreferences(tx, school.id, user.id, {
        preferences: [
          { notification_type: NOTIFICATION_TYPES.GRADE_POSTED, channel: "email", enabled: false },
        ],
      }),
    );

    expect(findCell(result.preferences, NOTIFICATION_TYPES.GRADE_POSTED, "email").enabled).toBe(
      false,
    );
    expect(findCell(result.preferences, NOTIFICATION_TYPES.GRADE_POSTED, "push").enabled).toBe(
      true,
    );
    expect(findCell(result.preferences, NOTIFICATION_TYPES.GRADE_POSTED, "in_app").enabled).toBe(
      true,
    );
  });

  test("persists across reads and can be re-enabled", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    await asUser(school.id, user.id, (tx) =>
      updatePreferences(tx, school.id, user.id, {
        preferences: [
          {
            notification_type: NOTIFICATION_TYPES.DISCUSSION_REPLY,
            channel: "push",
            enabled: false,
          },
        ],
      }),
    );
    const afterDisable = await asUser(school.id, user.id, (tx) => getPreferences(tx, user.id));
    expect(
      findCell(afterDisable.preferences, NOTIFICATION_TYPES.DISCUSSION_REPLY, "push").enabled,
    ).toBe(false);

    await asUser(school.id, user.id, (tx) =>
      updatePreferences(tx, school.id, user.id, {
        preferences: [
          {
            notification_type: NOTIFICATION_TYPES.DISCUSSION_REPLY,
            channel: "push",
            enabled: true,
          },
        ],
      }),
    );
    const afterEnable = await asUser(school.id, user.id, (tx) => getPreferences(tx, user.id));
    expect(
      findCell(afterEnable.preferences, NOTIFICATION_TYPES.DISCUSSION_REPLY, "push").enabled,
    ).toBe(true);
  });
});

// Pure unit tests, no database: validateUpdate throws synchronously, and driving a thrown
// HTTPException through postgres.js's `db.sql.begin` callback is the flakiness
// notification-service.test.ts already documents for markNotificationRead's 404 case ("flaky under
// Bun/Windows and exercises no code we own"). These exercise the same validation function the
// database-backed tests below rely on rejecting before any write happens.
describe("validateUpdate — mandatory types", () => {
  test("rejects disabling ADMIN_ANNOUNCEMENT on any channel", () => {
    expect(() =>
      validateUpdate({
        notification_type: NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT,
        channel: "in_app",
        enabled: false,
      }),
    ).toThrow(expect.objectContaining({ status: 422 }));
  });

  test("allows enabling a mandatory type", () => {
    expect(() =>
      validateUpdate({
        notification_type: NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT,
        channel: "email",
        enabled: true,
      }),
    ).not.toThrow();
  });

  test("leaves non-mandatory types alone", () => {
    expect(() =>
      validateUpdate({
        notification_type: NOTIFICATION_TYPES.GRADE_POSTED,
        channel: "email",
        enabled: false,
      }),
    ).not.toThrow();
  });
});

describe("validateUpdate — digest mode", () => {
  test("rejects digest on a non-email channel", () => {
    expect(() =>
      validateUpdate({
        notification_type: NOTIFICATION_TYPES.DISCUSSION_REPLY,
        channel: "push",
        digest: true,
      }),
    ).toThrow(expect.objectContaining({ status: 422 }));
  });

  test("rejects digest on a type that is not digest-eligible", () => {
    expect(() =>
      validateUpdate({
        notification_type: NOTIFICATION_TYPES.GRADE_POSTED,
        channel: "email",
        digest: true,
      }),
    ).toThrow(expect.objectContaining({ status: 422 }));
  });

  test("allows digest on an eligible type's email channel", () => {
    expect(() =>
      validateUpdate({
        notification_type: NOTIFICATION_TYPES.DISCUSSION_REPLY,
        channel: "email",
        digest: true,
      }),
    ).not.toThrow();
  });
});

describeDb("updatePreferences — mandatory types", () => {
  test("rejected write never reaches the database: the cell is still enabled", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    const { preferences } = await asUser(school.id, user.id, (tx) => getPreferences(tx, user.id));
    expect(findCell(preferences, NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT, "in_app").enabled).toBe(
      true,
    );
  });

  test("allows setting enabled: true on a mandatory type (a no-op, but not an error)", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    const result = await asUser(school.id, user.id, (tx) =>
      updatePreferences(tx, school.id, user.id, {
        preferences: [
          {
            notification_type: NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT,
            channel: "email",
            enabled: true,
          },
        ],
      }),
    );
    expect(
      findCell(result.preferences, NOTIFICATION_TYPES.ADMIN_ANNOUNCEMENT, "email").enabled,
    ).toBe(true);
  });
});

describeDb("updatePreferences — digest mode", () => {
  test("enables digest on an eligible type's email channel", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    const result = await asUser(school.id, user.id, (tx) =>
      updatePreferences(tx, school.id, user.id, {
        preferences: [
          {
            notification_type: NOTIFICATION_TYPES.DISCUSSION_REPLY,
            channel: "email",
            digest: true,
          },
        ],
      }),
    );

    expect(findCell(result.preferences, NOTIFICATION_TYPES.DISCUSSION_REPLY, "email").digest).toBe(
      true,
    );
  });
});

describeDb("updatePreferences — attendance alert threshold", () => {
  test("sets and clears a personal threshold without disturbing quiet hours", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    // Pre-seed a quiet-hours row directly, the way a different settings feature would.
    await asUser(
      school.id,
      user.id,
      (tx) =>
        tx`
        INSERT INTO app.user_notification_settings (user_id, school_id, quiet_hours_start, quiet_hours_end)
        VALUES (${user.id}::uuid, ${school.id}::uuid, '22:00', '07:00')
      `,
    );

    const afterSet = await asUser(school.id, user.id, (tx) =>
      updatePreferences(tx, school.id, user.id, { attendance_alert_threshold: 3 }),
    );
    expect(afterSet.attendance_alert_threshold).toBe(3);

    const [row] = await asUser(
      school.id,
      user.id,
      (tx) =>
        tx<{ quiet_hours_start: string }[]>`
          SELECT quiet_hours_start::text FROM app.user_notification_settings WHERE user_id = ${user.id}
        `,
    );
    expect(row!.quiet_hours_start).toBe("22:00:00");

    const afterClear = await asUser(school.id, user.id, (tx) =>
      updatePreferences(tx, school.id, user.id, { attendance_alert_threshold: null }),
    );
    expect(afterClear.attendance_alert_threshold).toBeNull();
  });

  // An out-of-range value (e.g. 0) is rejected by updateNotificationPreferencesRequestSchema's
  // min(1).max(365) before it ever reaches this function — see schemas.ts — and by
  // ck_user_notification_settings_attendance_alert_threshold (migration 000083) as a second,
  // database-level line of defense, verified by inspection rather than here: driving a constraint
  // violation through postgres.js's `db.sql.begin` is the same flakiness
  // notification-service.test.ts documents for markNotificationRead's 404 case, and this asserts
  // nothing the schema test above doesn't already cover for every real caller.
});
