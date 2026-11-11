/**
 * The data retention sweep against a real database: for each category it seeds rows just past and
 * just inside the period, runs the sweep, and checks only the expired ones are gone -- for school
 * applications only rejected ones, by their rejection date; for notifications also the logs that
 * point at them (000188); for export bundles only the objects under the expired request's prefix.
 * Storage is an in-memory fake. Skipped (as `skipIf` tests) unless TEST_DATABASE_URL points at a
 * migrated database.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  DATA_RETENTION_BATCH_SIZE,
  DATA_RETENTION_RULES,
  purgeExpiredRetainedData,
  retentionCutoff,
} from "./data-retention-sweep";

import type { RetentionObjectStore } from "./data-retention-sweep";
import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const sweepTest = test.skipIf(!enabled);

let db: Sql | undefined;

/** Tags this run's global rows so assertions and cleanup touch nothing else in the database. */
const run = crypto.randomUUID().slice(0, 8);
const securityPath = `/retention-test/${run}`;
const seededInquiries: string[] = [];
const seededApplications: string[] = [];

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  if (!db) return;
  await asAdmin(async (tx) => {
    await tx`DELETE FROM app.security_events WHERE request_path = ${securityPath}`;
    await tx`DELETE FROM app.sales_inquiries WHERE id = ANY(${seededInquiries}::uuid[])`;
    await tx`DELETE FROM app.school_applications WHERE id = ANY(${seededApplications}::uuid[])`;
  });
  await db.end({ timeout: 5 });
});

class FakeStore implements RetentionObjectStore {
  readonly objects = new Set<string>();
  readonly removed: string[] = [];
  readonly failing = new Set<string>();

  async *list(prefix: string): AsyncIterable<{ key: string }> {
    for (const key of [...this.objects]) if (key.startsWith(prefix)) yield { key };
  }

  async remove(key: string): Promise<void> {
    if (this.failing.has(key)) throw new Error(`cannot delete ${key}`);
    this.objects.delete(key);
    this.removed.push(key);
  }
}

function asAdmin<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    return fn(tx);
  }) as Promise<T>;
}

function asSchool<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function reference(): Promise<{ country: string; currency: string }> {
  const [row] = await db!<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'JO') AS country,
      (SELECT id FROM app.currencies WHERE code = 'JOD') AS currency
  `;
  return row!;
}

interface SeededSchool {
  schoolId: string;
  userId: string;
  parentId: string;
  studentId: string;
}

async function seedSchool(): Promise<SeededSchool> {
  const { country, currency } = await reference();
  return asAdmin(async (tx) => {
    const slug = `retention-${run}-${crypto.randomUUID().slice(0, 6)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, ${`Retention ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
              ${country}, ${currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${schoolId}::uuid, ${`${slug}@student.local`}, ${`${slug}@student.local`}, 'active')
      RETURNING id
    `;
    const [parent] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      VALUES (${schoolId}::uuid, ${`${slug}@parent.local`}, ${`${slug}@parent.local`}, 'active')
      RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${schoolId}::uuid, ${user!.id}::uuid, ${slug}, 'Retention', 'Student')
      RETURNING id
    `;
    return { schoolId, userId: user!.id, parentId: parent!.id, studentId: student!.id };
  });
}

/** One notification created [age] ago (an SQL interval), optionally read a day later. */
async function seedNotification(school: SeededSchool, age: string, read: boolean) {
  return asSchool(school.schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.notifications
        (school_id, user_id, notification_type, title, body, read_at, created_at, updated_at)
      VALUES (
        ${school.schoolId}::uuid, ${school.userId}::uuid, 'GRADE_POSTED', 'Grade posted', 'A grade',
        CASE WHEN ${read} THEN now() - ${age}::interval + interval '1 day' END,
        now() - ${age}::interval, now() - ${age}::interval + interval '1 day'
      )
      RETURNING id
    `;
    return row!.id;
  });
}

describe("data retention sweep", () => {
  test("periods are 12 months, and 30 days for export bundles", () => {
    expect(
      Object.fromEntries(
        DATA_RETENTION_RULES.map((rule) => [
          rule.category,
          "months" in rule ? `${rule.months} months` : `${rule.days} days`,
        ]),
      ),
    ).toEqual({
      securityEvents: "12 months",
      salesInquiries: "12 months",
      rejectedSchoolApplications: "12 months",
      notifications: "12 months",
      dsrExports: "30 days",
    });
    const now = new Date("2026-11-11T03:15:00Z");
    expect(retentionCutoff("notifications", now).toISOString()).toBe("2025-11-11T03:15:00.000Z");
    expect(retentionCutoff("dsrExports", now).toISOString()).toBe("2026-10-12T03:15:00.000Z");
  });

  sweepTest("deletes security events and sales inquiries older than 12 months", async () => {
    await asAdmin(async (tx) => {
      await tx`
        INSERT INTO app.security_events (event_type, request_path, request_method, created_at)
        SELECT 'csrf_missing_token', ${securityPath}, 'POST', now() - interval '13 months'
        FROM generate_series(1, ${DATA_RETENTION_BATCH_SIZE + 1})
      `;
      await tx`
        INSERT INTO app.security_events (event_type, request_path, request_method, created_at)
        VALUES ('cors_origin_rejected', ${securityPath}, 'GET', now() - interval '11 months')
      `;
      for (const age of ["13 months", "11 months"]) {
        const [inquiry] = await tx<{ id: string }[]>`
          INSERT INTO app.sales_inquiries (full_name, email, school_name, created_at, updated_at)
          VALUES ('Prospect', ${`${run}@prospect.local`}, 'Prospect School',
                  now() - ${age}::interval, now() - ${age}::interval)
          RETURNING id
        `;
        seededInquiries.push(inquiry!.id);
      }
    });

    const result = await purgeExpiredRetainedData(db!, new FakeStore());

    expect(result.failed).toBe(0);
    expect(result.securityEvents).toBeGreaterThanOrEqual(DATA_RETENTION_BATCH_SIZE + 1);
    expect(result.salesInquiries).toBeGreaterThanOrEqual(1);
    await asAdmin(async (tx) => {
      const events = await tx<{ event_type: string }[]>`
        SELECT event_type::text FROM app.security_events WHERE request_path = ${securityPath}
      `;
      expect(events.map((row) => row.event_type)).toEqual(["cors_origin_rejected"]);
      const inquiries = await tx<{ id: string }[]>`
        SELECT id FROM app.sales_inquiries WHERE id = ANY(${seededInquiries}::uuid[])
      `;
      expect(inquiries.map((row) => row.id)).toEqual([seededInquiries[1]!]);
    });
  });

  sweepTest(
    "deletes rejected applications 12 months after the rejection, with their proof",
    async () => {
      const school = await seedSchool();
      const { country, currency } = await reference();
      const store = new FakeStore();
      const sharedKey = `permanent/school-applications/${crypto.randomUUID()}/shared.pdf`;
      const seed = async (
        label: string,
        status: "pending" | "approved" | "rejected",
        reviewedAgo: string | null,
        proofKey = `permanent/school-applications/${crypto.randomUUID()}/${label}.pdf`,
      ) => {
        store.objects.add(proofKey);
        const [row] = await asAdmin(
          (tx) =>
            tx<{ id: string }[]>`
            INSERT INTO app.school_applications (
              status, provider, provider_subject, applicant_email, applicant_name, applicant_phone,
              school_name, country_id, default_currency_id, city, address,
              proof_storage_key, proof_file_name, proof_content_type, proof_size_bytes,
              reviewed_at, provisioned_school_id, created_at, updated_at
            ) VALUES (
              ${status}, 'google', ${`${run}-${label}`}, ${`${run}-${label}@applicant.local`},
              'Applicant', '+962700000000', 'Applicant School', ${country}::uuid,
              ${currency}::uuid, 'Amman', 'Main street', ${proofKey}, ${`${label}.pdf`},
              'application/pdf', 1000,
              now() - ${reviewedAgo}::interval,
              ${status === "approved" ? school.schoolId : null}::uuid,
              now() - interval '14 months', now() - interval '14 months'
            )
            RETURNING id
          `,
        );
        seededApplications.push(row!.id);
        return { id: row!.id, proofKey };
      };

      const rejectedOld = await seed("rejected-old", "rejected", "13 months");
      const rejectedRecent = await seed("rejected-recent", "rejected", "11 months");
      const approvedOld = await seed("approved-old", "approved", "13 months");
      const pendingOld = await seed("pending-old", "pending", null);
      const sharedOld = await seed("shared-old", "rejected", "13 months", sharedKey);
      const sharedRecent = await seed("shared-recent", "rejected", "11 months", sharedKey);

      const result = await purgeExpiredRetainedData(db!, store);

      expect(result.failed).toBe(0);
      const remaining = await asAdmin(
        (tx) =>
          tx<{ id: string }[]>`
          SELECT id FROM app.school_applications WHERE id = ANY(${seededApplications}::uuid[])
        `,
      );
      expect(new Set(remaining.map((row) => row.id))).toEqual(
        new Set([rejectedRecent.id, approvedOld.id, pendingOld.id, sharedRecent.id]),
      );
      expect(sharedOld.id).not.toBe(sharedRecent.id);
      // Only the expired rejection's own proof; the shared one is still referenced.
      const mine = new Set(
        [rejectedOld, rejectedRecent, approvedOld, pendingOld, sharedOld].map((a) => a.proofKey),
      );
      expect(store.removed.filter((key) => mine.has(key))).toEqual([rejectedOld.proofKey]);
    },
  );

  sweepTest(
    "deletes notifications older than 12 months and keeps the logs that pointed at them",
    async () => {
      const school = await seedSchool();
      const oldUnread = await seedNotification(school, "13 months", false);
      const oldRead = await seedNotification(school, "13 months", true);
      const recent = await seedNotification(school, "11 months", false);

      // Every log that links to an inbox row: before 000188 each of these blocked the delete.
      await asSchool(school.schoolId, async (tx) => {
        await tx`
          INSERT INTO app.notification_dispatch_logs
            (school_id, event_id, event_type, recipient_id, recipient_role, channel,
             idempotency_key, status, rendered_title, rendered_body, notification_id)
          VALUES (${school.schoolId}::uuid, ${`evt-${run}`}, 'grade.posted',
                  ${school.userId}::uuid, 'student', 'in_app', ${`key-${run}`}, 'delivered',
                  'Grade posted', 'A grade', ${oldRead}::uuid)
        `;
        const [announcement] = await tx<{ id: string }[]>`
          INSERT INTO app.announcements
            (school_id, created_by, title, body, audience_type, status, scheduled_at, published_at)
          VALUES (${school.schoolId}::uuid, ${school.parentId}::uuid, 'Notice', 'Body', 'school',
                  'published', now(), now())
          RETURNING id
        `;
        await tx`
          INSERT INTO app.announcement_recipients
            (school_id, announcement_id, user_id, notified_at, notification_id)
          VALUES (${school.schoolId}::uuid, ${announcement!.id}::uuid, ${school.userId}::uuid,
                  now() - interval '13 months', ${oldRead}::uuid)
        `;
        await tx`
          INSERT INTO app.attendance_alert_logs
            (school_id, student_id, parent_user_id, rule_type, threshold_value, dedup_key,
             notification_id)
          VALUES (${school.schoolId}::uuid, ${school.studentId}::uuid, ${school.parentId}::uuid,
                  'consecutive_days', 3, 'consecutive_days:3:2025-01-01', ${oldUnread}::uuid)
        `;
      });

      const result = await purgeExpiredRetainedData(db!, new FakeStore());

      expect(result.failed).toBe(0);
      expect(result.notifications).toBeGreaterThanOrEqual(2);
      await asSchool(school.schoolId, async (tx) => {
        const left = await tx<{ id: string }[]>`
          SELECT id FROM app.notifications WHERE school_id = ${school.schoolId}::uuid
        `;
        expect(left.map((row) => row.id)).toEqual([recent]);
        const [links] = await tx<
          {
            dispatch: string | null;
            recipient: string | null;
            notified: boolean;
            alert: string | null;
          }[]
        >`
          SELECT
            (SELECT notification_id FROM app.notification_dispatch_logs
              WHERE school_id = ${school.schoolId}::uuid) AS dispatch,
            (SELECT notification_id FROM app.announcement_recipients
              WHERE school_id = ${school.schoolId}::uuid) AS recipient,
            (SELECT notified_at IS NOT NULL FROM app.announcement_recipients
              WHERE school_id = ${school.schoolId}::uuid) AS notified,
            (SELECT notification_id FROM app.attendance_alert_logs
              WHERE school_id = ${school.schoolId}::uuid) AS alert
        `;
        expect(links).toEqual({ dispatch: null, recipient: null, notified: true, alert: null });
      });
    },
  );

  sweepTest(
    "deletes export bundles 30 days after the request finished and keeps the request",
    async () => {
      const school = await seedSchool();
      const store = new FakeStore();
      const unrelated = `permanent/${school.schoolId}/materials/${run}/notes.pdf`;
      store.objects.add(unrelated);

      const seed = async (
        requestType: "export" | "erasure",
        status: "completed" | "failed",
        daysAgo: number,
      ) => {
        const id = crypto.randomUUID();
        const prefix = `dsr-exports/${school.schoolId}/${id}`;
        const keys =
          requestType === "export"
            ? [`${prefix}/manifest.json`, `${prefix}/data/users.ndjson`]
            : [];
        for (const key of keys) store.objects.add(key);
        await asSchool(
          school.schoolId,
          (tx) =>
            tx`
            INSERT INTO app.data_subject_requests
              (id, school_id, request_type, subject_scope, reason, subject_user_id,
               requested_by_user_id, status, storage_key, failure_message, sla_due_at,
               created_at, completed_at, updated_at)
            VALUES (
              ${id}::uuid, ${school.schoolId}::uuid, ${requestType}, 'user', 'user_request',
              ${school.userId}::uuid, ${school.parentId}::uuid, ${status},
              ${status === "completed" && requestType === "export" ? keys[0]! : null},
              ${status === "failed" ? "export failed" : null},
              now() - make_interval(days => ${daysAgo + 1}) + interval '30 days',
              now() - make_interval(days => ${daysAgo + 1}),
              now() - make_interval(days => ${daysAgo}),
              now() - make_interval(days => ${daysAgo})
            )
          `,
        );
        return { id, keys };
      };

      const expired = await seed("export", "completed", 31);
      const failedExpired = await seed("export", "failed", 31);
      const stuck = await seed("export", "completed", 40);
      const fresh = await seed("export", "completed", 29);
      const erasure = await seed("erasure", "completed", 31);
      store.failing.add(stuck.keys[1]!);

      const first = await purgeExpiredRetainedData(db!, store);

      expect(first.failed).toBe(0);
      const mine = (key: string) => key.startsWith(`dsr-exports/${school.schoolId}/`);
      expect(new Set(store.removed.filter(mine))).toEqual(
        new Set([...expired.keys, ...failedExpired.keys, stuck.keys[0]!]),
      );
      expect(store.objects.has(unrelated)).toBe(true);
      for (const key of fresh.keys) expect(store.objects.has(key)).toBe(true);

      const rows = async () =>
        asSchool(
          school.schoolId,
          (tx) =>
            tx<{ id: string; storage_key: string | null; deleted: boolean }[]>`
            SELECT id, storage_key, export_deleted_at IS NOT NULL AS deleted
            FROM app.data_subject_requests WHERE school_id = ${school.schoolId}::uuid
          `,
        );
      const byId = new Map((await rows()).map((row) => [row.id, row]));
      expect(byId.size).toBe(5);
      expect(byId.get(expired.id)).toEqual({
        id: expired.id,
        storage_key: expired.keys[0]!,
        deleted: true,
      });
      expect(byId.get(failedExpired.id)!.deleted).toBe(true);
      expect(byId.get(stuck.id)!.deleted).toBe(false);
      expect(byId.get(fresh.id)!.deleted).toBe(false);
      expect(byId.get(erasure.id)!.deleted).toBe(false);

      // The object that failed is retried on the next run; finished bundles are not listed again.
      store.failing.clear();
      store.removed.length = 0;
      await purgeExpiredRetainedData(db!, store);
      expect(store.removed.filter(mine)).toEqual([stuck.keys[1]!]);
      expect((await rows()).find((row) => row.id === stuck.id)!.deleted).toBe(true);
    },
  );

  sweepTest("without object storage, rows that own stored files are left alone", async () => {
    const school = await seedSchool();
    const { country, currency } = await reference();
    const [application] = await asAdmin(
      (tx) =>
        tx<{ id: string }[]>`
        INSERT INTO app.school_applications (
          status, provider, provider_subject, applicant_email, applicant_name, applicant_phone,
          school_name, country_id, default_currency_id, city, address, proof_storage_key,
          proof_file_name, proof_content_type, proof_size_bytes, reviewed_at, created_at, updated_at
        ) VALUES (
          'rejected', 'google', ${`${run}-nostorage`}, ${`${run}-nostorage@applicant.local`},
          'Applicant', '+962700000000', 'Applicant School', ${country}::uuid, ${currency}::uuid,
          'Amman', 'Main street', ${`permanent/school-applications/${crypto.randomUUID()}/p.pdf`},
          'p.pdf', 'application/pdf', 1000, now() - interval '13 months',
          now() - interval '14 months', now() - interval '14 months'
        )
        RETURNING id
      `,
    );
    seededApplications.push(application!.id);
    const old = await seedNotification(school, "13 months", false);

    const result = await purgeExpiredRetainedData(db!, null);

    expect(result.rejectedSchoolApplications).toBe(0);
    expect(result.dsrExports).toBe(0);
    const [kept] = await asAdmin(
      (tx) =>
        tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.school_applications WHERE id = ${application!.id}::uuid
      `,
    );
    expect(kept!.count).toBe(1);
    // Notifications own no files, so they are still deleted.
    const [gone] = await asSchool(
      school.schoolId,
      (tx) =>
        tx<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM app.notifications WHERE id = ${old}::uuid`,
    );
    expect(gone!.count).toBe(0);
  });
});
