/**
 * QA-091: keyset pagination must not drop rows that share a timestamp down to the millisecond.
 *
 * Postgres keeps microseconds; a JS Date keeps milliseconds. The cursor carries the last row's
 * timestamp as a Date, so the next page's `(ts, id) < (cursor_ts, cursor_id)` used to compare
 * against a value up to 999 microseconds *earlier* than the row it came from -- and every row in
 * that millisecond, including every row one transaction wrote (they share `now()`), compared greater
 * and was skipped. A 500-student import showed page one and nothing after it.
 *
 * Each case seeds more rows than a page, gives them all one identical microsecond timestamp (the
 * same-transaction shape), pages through with limit=2, and requires every row exactly once.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL:
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/pagination/keyset-microsecond.test.ts
 */

// Imported before src/middleware -- see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  createFullTenant,
  createStudent,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";

const describeDb = integrationEnabled ? describe : describe.skip;

/** One instant with a sub-millisecond part, so truncating it to a Date changes it. */
const SHARED_INSTANT = "2026-09-01 08:00:00.123456+00";
const ROWS = 5;

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

async function tokenFor(fixture: TenantFixture): Promise<string> {
  return mintTestToken(harness!.keyStore, {
    schoolId: fixture.schoolId,
    userId: fixture.users[ROLES.ORG_ADMIN].id,
    roles: [ROLES.ORG_ADMIN],
    channel: "web",
  });
}

/** Page through `path` with limit=2 and return every item id seen, in order. */
async function pageAll(
  path: string,
  token: string,
  idOf: (item: Record<string, unknown>) => string,
) {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${separator}limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response = await harness!.app.request(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(`${url} -> ${response.status}`).toBe(`${url} -> 200`);
    const body = (await response.json()) as Record<string, unknown>;
    const items = Object.values(body).find((value) => Array.isArray(value)) as
      Record<string, unknown>[] | undefined;
    seen.push(...(items ?? []).map(idOf));
    cursor = (body.next_cursor as string | null | undefined) ?? null;
    if (!cursor) return seen;
  }
  throw new Error(`${path}: more than 50 pages -- the cursor is not advancing`);
}

/** Give rows one shared microsecond timestamp, as a single transaction's inserts would have. */
async function shareInstant(table: string, column: string, ids: string[]): Promise<void> {
  // table/column are fixed literals from this file, never input.
  // A SQL literal, not a bound parameter: postgres.js serialises timestamptz parameters through a
  // JS Date, which would truncate the instant to milliseconds before it reached the database. Real
  // rows get their microseconds from the database's own now(), so the literal is the faithful seed.
  await database!.sql.unsafe(
    `UPDATE app.${table} SET ${column} = timestamptz '${SHARED_INSTANT}' WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}

function expectEveryRowOnce(seen: string[], seeded: string[]): void {
  const seededSet = new Set(seeded);
  const relevant = seen.filter((id) => seededSet.has(id));
  expect(new Set(relevant).size).toBe(relevant.length); // no duplicates
  expect([...seededSet].filter((id) => !relevant.includes(id))).toEqual([]); // none dropped
}

describeDb("keyset pagination across one shared microsecond timestamp (QA-091)", () => {
  test("GET /api/students returns every student exactly once", async () => {
    const fixture = await createFullTenant(database!.sql);
    const seeded: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      seeded.push(
        (await createStudent(database!.sql, fixture.schoolId, { firstName: `Imported${i}` })).id,
      );
    }
    await shareInstant("students", "created_at", seeded);
    expectEveryRowOnce(
      await pageAll("/api/students", await tokenFor(fixture), (s) => s.id as string),
      seeded,
    );
  });

  test("GET /api/users returns every user exactly once", async () => {
    const fixture = await createFullTenant(database!.sql);
    const seeded: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const user = await createUser(database!.sql, fixture.schoolId, { displayName: `Bulk ${i}` });
      await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.INSTRUCTOR);
      seeded.push(user.id);
    }
    await shareInstant("users", "created_at", seeded);
    expectEveryRowOnce(
      await pageAll("/api/users", await tokenFor(fixture), (u) => u.id as string),
      seeded,
    );
  });

  test("GET /api/teachers returns every teacher exactly once", async () => {
    const fixture = await createFullTenant(database!.sql);
    const seeded: string[] = [];
    for (let i = 0; i < ROWS; i++)
      seeded.push((await createTeacher(database!.sql, fixture.schoolId)).id);
    await shareInstant("teachers", "created_at", seeded);
    expectEveryRowOnce(
      await pageAll("/api/teachers", await tokenFor(fixture), (t) => t.id as string),
      seeded,
    );
  });

  test("GET /api/parents returns every parent exactly once", async () => {
    const fixture = await createFullTenant(database!.sql);
    const seeded: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const user = await createUser(database!.sql, fixture.schoolId, {
        displayName: `Parent ${i}`,
      });
      await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.PARENT);
      seeded.push(user.id);
    }
    await shareInstant("users", "created_at", seeded);
    expectEveryRowOnce(
      await pageAll("/api/parents", await tokenFor(fixture), (p) => (p.user_id ?? p.id) as string),
      seeded,
    );
  });

  test("GET /api/notifications returns every notification exactly once", async () => {
    const fixture = await createFullTenant(database!.sql);
    const rows = await database!.sql<{ id: string }[]>`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body)
      SELECT ${fixture.schoolId}, ${fixture.users[ROLES.ORG_ADMIN].id}, 'SUPPORT_MESSAGE',
             'Fan-out ' || g, 'b'
      FROM generate_series(1, ${ROWS}) g
      RETURNING id
    `;
    const seeded = rows.map((r) => r.id);
    await shareInstant("notifications", "created_at", seeded);
    expectEveryRowOnce(
      await pageAll("/api/notifications", await tokenFor(fixture), (n) => n.id as string),
      seeded,
    );
  });

  test("GET /api/announcements returns every announcement exactly once", async () => {
    const fixture = await createFullTenant(database!.sql);
    const rows = await database!.sql<{ id: string }[]>`
      INSERT INTO app.announcements
        (school_id, created_by, title, body, mandatory, audience_type, status, scheduled_at, published_at)
      SELECT ${fixture.schoolId}, ${fixture.users[ROLES.ORG_ADMIN].id}, 'Bulk ' || g, 'b', false,
             'school', 'published', now(), now()
      FROM generate_series(1, ${ROWS}) g
      RETURNING id
    `;
    const seeded = rows.map((r) => r.id);
    await shareInstant("announcements", "created_at", seeded);
    expectEveryRowOnce(
      await pageAll("/api/announcements", await tokenFor(fixture), (a) => a.id as string),
      seeded,
    );
  });

  test("GET /api/finance/invoices returns every invoice exactly once (ordered by last_synced_at)", async () => {
    const fixture = await createFullTenant(database!.sql);
    const studentId = fixture.students[0]!.id;
    const rows = await database!.sql<{ id: string }[]>`
      INSERT INTO app.invoice_cache
        (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
         total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
      SELECT ${fixture.schoolId}::uuid, ${studentId}::uuid,
             (SELECT id FROM app.currencies WHERE code = 'USD'), 'INV-SYNC-' || g, 'submitted',
             100000, 100000, '2026-09-01'::date, now()
      FROM generate_series(1, ${ROWS}) g
      RETURNING id
    `;
    const seeded = rows.map((r) => r.id);
    await shareInstant("invoice_cache", "last_synced_at", seeded);
    const finance = await createUser(database!.sql, fixture.schoolId, { displayName: "Finance" });
    await assignRole(database!.sql, fixture.schoolId, finance.id, ROLES.FINANCE);
    const token = await mintTestToken(harness!.keyStore, {
      schoolId: fixture.schoolId,
      userId: finance.id,
      roles: [ROLES.FINANCE],
      channel: "web",
    });
    expectEveryRowOnce(
      await pageAll("/api/finance/invoices", token, (i) => i.id as string),
      seeded,
    );
  });

  test("a cursor whose row was deleted between pages still pages on (falls back to its own value)", async () => {
    const fixture = await createFullTenant(database!.sql);
    const token = await tokenFor(fixture);
    const rows = await database!.sql<{ id: string }[]>`
      INSERT INTO app.notifications (school_id, user_id, notification_type, title, body)
      SELECT ${fixture.schoolId}, ${fixture.users[ROLES.ORG_ADMIN].id}, 'SUPPORT_MESSAGE',
             'Deleted-cursor ' || g, 'b'
      FROM generate_series(1, ${ROWS}) g
      RETURNING id
    `;
    // Distinct, well-separated instants: this case is about the missing row, not precision.
    await database!.sql`
      UPDATE app.notifications n SET created_at = timestamptz '2026-09-01 08:00:00+00' + (g.i * interval '1 second')
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS i FROM unnest(${rows.map((r) => r.id)}::uuid[]) AS id) g
      WHERE n.id = g.id
    `;
    const first = await harness!.app.request("/api/notifications?limit=2", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const page = (await first.json()) as { notifications: { id: string }[]; next_cursor: string };
    const cursorRowId = page.notifications.at(-1)!.id;
    await database!.sql`DELETE FROM app.notifications WHERE id = ${cursorRowId}::uuid`;

    const second = await harness!.app.request(
      `/api/notifications?limit=10&cursor=${encodeURIComponent(page.next_cursor)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(second.status).toBe(200);
    const rest = (await second.json()) as { notifications: { id: string }[] };
    const shown = new Set([...page.notifications, ...rest.notifications].map((n) => n.id));
    // Every surviving row is reachable; the deleted one simply isn't there.
    const surviving = rows.map((r) => r.id).filter((id) => id !== cursorRowId);
    expect(surviving.filter((id) => !shown.has(id))).toEqual([]);
  });
});
