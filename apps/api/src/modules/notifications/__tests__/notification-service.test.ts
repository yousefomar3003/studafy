/**
 * In-app inbox service tests (ST-142).
 *
 * Integration tests that require a live PostgreSQL instance. Each test creates its own school and
 * user via the test harness factories, inserts inbox rows directly (INSERT is tenant-scoped, not
 * self-scoped — a sender writes for a recipient), then exercises the service functions inside a
 * tenant transaction with `app.user_id` set to the recipient, exactly as the route does.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/notifications/__tests__
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
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
  countUnread,
  listNotifications,
  markAllRead,
  markNotificationRead,
} from "../notification-service";

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

/** The recipient's view: the same GUC setup withTenantTx performs for the route. */
async function asRecipient<T>(
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

async function insertNotification(
  schoolId: string,
  userId: string,
  overrides: {
    notificationType?: string;
    title?: string;
    readAt?: Date | null;
    createdAt?: Date;
  } = {},
): Promise<{ id: string }> {
  let result: { id: string } | undefined;
  await db.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true),
             set_config('app.user_id', ${userId}, true)
    `;

    // Timestamps come from the DB clock, never the host clock: `updated_at` defaults to
    // CURRENT_TIMESTAMP and ck_notifications_timestamps (updated_at >= created_at) would otherwise
    // flake under host-vs-container clock drift. `created_at` may be overridden for pagination
    // ordering (the caller uses dates safely in the past). A provided `readAt` marks the row read
    // with read_at = created_at, which also satisfies ck_notifications_read_at by construction.
    const [clock] = await tx<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS now`;
    const createdAt = overrides.createdAt ?? clock.now;
    const readAt = overrides.readAt === undefined ? null : createdAt;

    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata, read_at, created_at)
      VALUES (
        ${schoolId}, ${userId},
        ${overrides.notificationType ?? "GRADE_POSTED"}::app.notification_type,
        ${overrides.title ?? "Grade posted"},
        'Amina scored 92 on the midterm.',
        '{"route":"/courses/course-1/grades"}'::jsonb,
        ${readAt},
        ${createdAt}
      )
      RETURNING id
    `;
    result = row;
  });
  return result!;
}

interface OutboxRow {
  event_name: string;
  payload: Record<string, unknown>;
}

async function outboxRows(schoolId: string): Promise<OutboxRow[]> {
  const rows = await db.sql<OutboxRow[]>`
    SELECT event_name, payload FROM app.outbox_events WHERE school_id = ${schoolId} ORDER BY id
  `;
  return rows;
}

// ---------------------------------------------------------------------------
// listNotifications
// ---------------------------------------------------------------------------

describeDb("listNotifications", () => {
  test("returns the inbox newest-first", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);
    const ids = new Set<string>();

    for (let i = 0; i < 3; i++) {
      const notification = await insertNotification(school.id, user.id, {
        title: `N${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
      ids.add(notification.id);
    }

    const { rows, next_cursor } = await asRecipient(school.id, user.id, (tx) =>
      listNotifications(tx, school.id, { limit: 10 }),
    );

    expect(next_cursor).toBeNull();
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(rows[0]!.title).toBe("N2");
    expect(rows[0]!.user_id).toBe(user.id);
    expect(rows[0]!.read_at).toBeNull();
  });

  test("keyset cursor pages without overlap or gaps", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    for (let i = 0; i < 5; i++) {
      await insertNotification(school.id, user.id, {
        title: `N${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page = await asRecipient(school.id, user.id, (tx) =>
        listNotifications(tx, school.id, { limit: 2, cursor: cursor ?? undefined }),
      );
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
  });

  test("unread_only returns only unread rows", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);
    await insertNotification(school.id, user.id, { title: "unread-1" });
    await insertNotification(school.id, user.id, { title: "read-1", readAt: new Date() });
    await insertNotification(school.id, user.id, { title: "unread-2" });

    const { rows } = await asRecipient(school.id, user.id, (tx) =>
      listNotifications(tx, school.id, { limit: 10, unreadOnly: true }),
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.read_at === null)).toBe(true);
  });

  test("does not expose another user's notifications", async () => {
    const school = await createSchool(db.sql);
    const recipient = await createUserFactory(db.sql, school.id);
    const other = await createUserFactory(db.sql, school.id);
    await insertNotification(school.id, other.id, { title: "other's" });

    const { rows } = await asRecipient(school.id, recipient.id, (tx) =>
      listNotifications(tx, school.id, { limit: 10 }),
    );

    expect(rows).toHaveLength(0);
  });

  test("rejects a malformed cursor", async () => {
    // decodeKeysetCursor throws before any SQL is executed, so no database round-trip happens here —
    // the service surfaces the CodedHttpException verbatim and the HTTP layer maps it to a 400
    // (covered end-to-end in tests/notifications/inbox-http.test.ts). Asserting that mapping directly
    // avoids driving the postgres driver's `begin` teardown with a non-SQL error.
    await expect(
      listNotifications(db.sql as unknown as TransactionSql, crypto.randomUUID(), {
        limit: 10,
        cursor: "not-a-cursor",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// countUnread
// ---------------------------------------------------------------------------

describeDb("countUnread", () => {
  test("counts unread only, scoped to the recipient", async () => {
    const school = await createSchool(db.sql);
    const recipient = await createUserFactory(db.sql, school.id);
    const other = await createUserFactory(db.sql, school.id);
    await insertNotification(school.id, recipient.id, { title: "unread-1" });
    await insertNotification(school.id, recipient.id, { title: "read-1", readAt: new Date() });
    await insertNotification(school.id, recipient.id, { title: "unread-2" });
    await insertNotification(school.id, other.id, { title: "other's unread" });

    const count = await asRecipient(school.id, recipient.id, (tx) => countUnread(tx, school.id));

    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// markNotificationRead
// ---------------------------------------------------------------------------

describeDb("markNotificationRead", () => {
  test("marks the row read and returns the new unread count", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);
    await insertNotification(school.id, user.id, { title: "a" });
    await insertNotification(school.id, user.id, { title: "b" });
    const target = await insertNotification(school.id, user.id, { title: "c" });

    const unread = await asRecipient(school.id, user.id, (tx) =>
      markNotificationRead(tx, school.id, user.id, target.id),
    );

    expect(unread).toBe(2);

    const row = await db.sql`
      SELECT read_at FROM app.notifications WHERE id = ${target.id}
    `;
    expect(row[0]!.read_at).not.toBeNull();
  });

  test("is idempotent and emits one notification.read event", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);
    const target = await insertNotification(school.id, user.id, { title: "a" });

    const first = await asRecipient(school.id, user.id, (tx) =>
      markNotificationRead(tx, school.id, user.id, target.id),
    );
    const second = await asRecipient(school.id, user.id, (tx) =>
      markNotificationRead(tx, school.id, user.id, target.id),
    );

    expect(first).toBe(0);
    expect(second).toBe(0);

    const events = (await outboxRows(school.id)).filter(
      (r) => r.event_name === DOMAIN_EVENTS.NOTIFICATION_READ,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      userId: user.id,
      notificationId: target.id,
      unreadCount: 0,
    });
  });

  // 404 handling is asserted at the HTTP layer (tests/notifications/inbox-http.test.ts): both "not
  // yours" and "does not exist" produce the same 404 (RLS hides other users' rows), and the response
  // mapping runs through the production withTenantTx manager. Driving a thrown HTTPException through
  // the postgres driver's `begin` here is flaky under Bun/Windows and exercises no code we own.
});

// ---------------------------------------------------------------------------
// markAllRead
// ---------------------------------------------------------------------------

describeDb("markAllRead", () => {
  test("marks every unread row read and returns zero", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);
    await insertNotification(school.id, user.id, { title: "a" });
    await insertNotification(school.id, user.id, { title: "b" });
    const readBefore = await insertNotification(school.id, user.id, {
      title: "c",
      readAt: new Date(),
    });

    const unread = await asRecipient(school.id, user.id, (tx) =>
      markAllRead(tx, school.id, user.id),
    );

    expect(unread).toBe(0);

    const rows = await db.sql`
      SELECT id, read_at FROM app.notifications WHERE id IN (${readBefore.id}) OR school_id = ${school.id}
    `;
    expect(rows.every((r) => r.read_at !== null)).toBe(true);
  });

  test("emits one notification.allRead event for the whole sweep", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);
    await insertNotification(school.id, user.id, { title: "a" });
    await insertNotification(school.id, user.id, { title: "b" });

    await asRecipient(school.id, user.id, (tx) => markAllRead(tx, school.id, user.id));

    const events = (await outboxRows(school.id)).filter(
      (r) => r.event_name === DOMAIN_EVENTS.NOTIFICATION_ALL_READ,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ userId: user.id, unreadCount: 0 });
  });

  test("emits nothing when there is nothing to clear", async () => {
    const school = await createSchool(db.sql);
    const user = await createUserFactory(db.sql, school.id);

    await asRecipient(school.id, user.id, (tx) => markAllRead(tx, school.id, user.id));

    const events = await outboxRows(school.id);
    expect(events.filter((r) => r.event_name === DOMAIN_EVENTS.NOTIFICATION_ALL_READ)).toHaveLength(
      0,
    );
  });
});
