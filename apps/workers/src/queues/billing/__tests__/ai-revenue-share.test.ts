/**
 * The Student AI revenue share in the hourly licence lifecycle job (migration 000237): the conversion
 * measurement taken and locked on its measurement day -- not the day before, and once -- with the
 * temporary adapters (enrolled students; the licence's student seats standing in for phase 2's
 * opt-ins); and, once the job stops a licence's AI for an instalment unpaid past its grace period,
 * that instalment's share forfeited while the shares of paid ones stay owed.
 *
 * Needs TEST_DATABASE_URL pointing at a fully migrated database, like the other billing job tests.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runLicenseLifecycle } from "../license-lifecycle";

import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const jobTest = test.skipIf(!enabled);

const DAY = 86_400_000;
const PROGRAMME_V1 = "a1000000-0000-4000-8000-000000000001";
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let db: Sql | undefined;
let usd = "";
let jo = "";
let tier = "";
let superAdmin = "";

async function admin<T>(
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

async function school(name: string): Promise<string> {
  const slug = `revshare-${crypto.randomUUID().slice(0, 8)}`;
  return admin(null, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, ${name}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`}, ${jo}::uuid, ${usd}::uuid)
      RETURNING id::text AS id
    `;
    return row!.id;
  });
}

async function user(schoolId: string, role?: string): Promise<string> {
  return admin(schoolId, async (tx) => {
    const email = `${crypto.randomUUID().slice(0, 8)}@revshare.local`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${email}, ${email}, 'Revshare User', 'active')
      RETURNING id::text AS id
    `;
    if (role) {
      await tx`
        INSERT INTO app.user_roles (school_id, user_id, role)
        VALUES (${schoolId}::uuid, ${row!.id}::uuid, ${role}::app.user_role)
      `;
    }
    return row!.id;
  });
}

async function student(schoolId: string): Promise<{ userId: string; studentId: string }> {
  const userId = await user(schoolId, "STUDENT");
  return admin(schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${userId}::uuid, ${`ADM-${crypto.randomUUID().slice(0, 8)}`}, 'Rev', 'Student', 'enrolled')
      RETURNING id::text AS id
    `;
    return { userId, studentId: row!.id };
  });
}

async function license(
  schoolId: string,
  options: { startsAt: Date; endsAt: Date; seats: number },
): Promise<string> {
  return admin(schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.school_licenses (
        school_id, status, starts_at, ends_at, student_plan_id, student_seats, currency_id,
        created_by, activated_at, ai_programme_version_id, nonpayment_grace_days
      ) VALUES (
        ${schoolId}::uuid, 'active', ${options.startsAt}, ${options.endsAt}, ${tier}::uuid,
        ${options.seats}, ${usd}::uuid, ${superAdmin}::uuid, ${options.startsAt},
        ${PROGRAMME_V1}::uuid, 30
      )
      RETURNING id::text AS id
    `;
    return row!.id;
  });
}

beforeAll(async () => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
  const [ref] = await db<{ usd: string; jo: string }[]>`
    SELECT (SELECT id::text FROM app.currencies WHERE code = 'USD') AS usd,
           (SELECT id::text FROM app.countries WHERE alpha2_code = 'JO') AS jo
  `;
  usd = ref!.usd;
  jo = ref!.jo;
  await admin(null, async (tx) => {
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES (${`student_revshare_${crypto.randomUUID().slice(0, 8)}`}, 'Student AI', 'student',
              ${200 + Math.floor(Math.random() * 30_000)})
      RETURNING id::text AS id
    `;
    tier = plan!.id;
  });
  const home = await school("Studafy HQ (revenue share)");
  await admin(
    null,
    (tx) => tx`UPDATE app.schools SET is_platform_tenant = true WHERE id = ${home}::uuid`,
  );
  superAdmin = await user(home, "SUPER_ADMIN");
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

const utcMidnight = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const iso = (date: Date) => date.toISOString().slice(0, 10);

describe("conversion measurement", () => {
  jobTest("taken and locked on the measurement day, not the day before, and once", async () => {
    const schoolId = await school("Measured School");
    // Starts tomorrow: measured 30 days later (the defaults' measurement offset).
    const start = utcMidnight(new Date(Date.now() + DAY));
    const lic = await license(schoolId, {
      startsAt: start,
      endsAt: new Date(start.getTime() + 300 * DAY),
      seats: 5,
    });
    const students: { userId: string; studentId: string }[] = [];
    for (let i = 0; i < 4; i += 1) students.push(await student(schoolId));
    await admin(schoolId, async (tx) => {
      for (const holder of students.slice(0, 3)) {
        await tx`
          INSERT INTO app.license_seats (school_id, license_id, audience, user_id, student_id, assigned_by)
          VALUES (${schoolId}::uuid, ${lic}::uuid, 'student', ${holder.userId}::uuid,
                  ${holder.studentId}::uuid, ${superAdmin}::uuid)
        `;
      }
    });

    const measureDay = new Date(start.getTime() + 30 * DAY);
    const before = await runLicenseLifecycle(
      db!,
      new Date(measureDay.getTime() - 60_000),
      silentLogger,
      [schoolId],
    );
    expect(before).toMatchObject({ conversionsLocked: 0, failedRevenueShareSchools: 0 });

    const on = await runLicenseLifecycle(
      db!,
      new Date(measureDay.getTime() + 3_600_000),
      silentLogger,
      [schoolId],
    );
    expect(on).toMatchObject({ conversionsLocked: 1, failedRevenueShareSchools: 0 });
    const snapshots = await admin(
      schoolId,
      (tx) => tx<
        {
          period_start: string;
          measure_on: string;
          enrolled_count: number;
          opted_in_count: number;
          conversion_bps: number;
          conversion_share_bps: number;
          locked: boolean;
          source: string;
        }[]
      >`
        SELECT period_start::text AS period_start, measure_on::text AS measure_on, enrolled_count,
               opted_in_count, conversion_bps, conversion_share_bps, locked, source
        FROM app.ai_programme_conversion_snapshots
        WHERE school_id = ${schoolId}::uuid AND license_id = ${lic}::uuid
      `,
    );
    // 3 of 4 enrolled students hold a seat: 75%, the 70-84% tier (10%).
    expect([...snapshots]).toEqual([
      {
        period_start: iso(start),
        measure_on: iso(measureDay),
        enrolled_count: 4,
        opted_in_count: 3,
        conversion_bps: 7500,
        conversion_share_bps: 1000,
        locked: true,
        source: "scheduled",
      },
    ]);

    const again = await runLicenseLifecycle(
      db!,
      new Date(measureDay.getTime() + 2 * DAY),
      silentLogger,
      [schoolId],
    );
    expect(again.conversionsLocked).toBe(0);

    const [audit] = await admin(
      schoolId,
      (tx) => tx<{ actor: string | null }[]>`
        SELECT actor_id::text AS actor FROM app.audit_logs
        WHERE school_id = ${schoolId}::uuid AND target_table = 'ai_programme_conversion_snapshots'
      `,
    );
    expect(audit).toEqual({ actor: null });
  });
});

describe("forfeiture after the AI stops", () => {
  jobTest("the unpaid instalment's share is forfeited; a paid one's stays owed", async () => {
    const schoolId = await school("Stopped School");
    const lic = await license(schoolId, {
      startsAt: new Date("2026-01-01T00:00:00Z"),
      endsAt: new Date("2030-01-01T00:00:00Z"),
      seats: 10,
    });
    const ids = await admin(schoolId, async (tx) => {
      const [snapshot] = await tx<{ id: string }[]>`
        INSERT INTO app.ai_programme_conversion_snapshots (
          school_id, license_id, period_start, measure_on, as_of, enrolled_count, opted_in_count,
          conversion_bps, seats, conversion_share_bps, floor_applied, ai_programme_version_id,
          locked, source
        ) VALUES (
          ${schoolId}::uuid, ${lic}::uuid, '2026-01-01', '2026-01-31', '2026-01-31', 10, 7, 7000,
          10, 1000, false, ${PROGRAMME_V1}::uuid, true, 'scheduled'
        )
        RETURNING id::text AS id
      `;
      const [invoice] = await tx<{ id: string }[]>`
        INSERT INTO app.license_invoices (
          school_id, license_id, number, payment_reference, currency_id, issue_date, due_date,
          subtotal_minor, total_minor, paid_minor, status, issued_by, payment_plan
        ) VALUES (
          ${schoolId}::uuid, ${lic}::uuid, app.next_license_invoice_number('2025-12-20'),
          ${`STF-${crypto.randomUUID().slice(0, 4).toUpperCase()}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`.replace(/[ILOU]/g, "A")},
          ${usd}::uuid, '2025-12-20', '2026-02-01', 8000, 8000, 6000, 'partially_paid',
          ${superAdmin}::uuid, 'monthly'
        )
        RETURNING id::text AS id
      `;
      const [first] = await tx<{ id: string }[]>`
        INSERT INTO app.license_invoice_instalments (
          school_id, invoice_id, position, amount_minor, paid_minor, due_date, status
        ) VALUES (${schoolId}::uuid, ${invoice!.id}::uuid, 1, 4000, 4000, '2026-01-01', 'paid')
        RETURNING id::text AS id
      `;
      const [second] = await tx<{ id: string }[]>`
        INSERT INTO app.license_invoice_instalments (
          school_id, invoice_id, position, amount_minor, paid_minor, due_date, status
        ) VALUES (${schoolId}::uuid, ${invoice!.id}::uuid, 2, 4000, 2000, '2026-02-01', 'partially_paid')
        RETURNING id::text AS id
      `;
      const payment = async (amount: number, receivedAt: string) =>
        (
          await tx<{ id: string }[]>`
            INSERT INTO app.license_payments (
              school_id, invoice_id, amount_minor, currency_id, received_at, bank_reference, recorded_by
            ) VALUES (
              ${schoolId}::uuid, ${invoice!.id}::uuid, ${amount}, ${usd}::uuid, ${receivedAt},
              ${`FT-${crypto.randomUUID().slice(0, 6)}`}, ${superAdmin}::uuid
            )
            RETURNING id::text AS id
          `
        )[0]!.id;
      const paidFirst = await payment(4000, "2026-01-01T10:00:00Z");
      const paidHalf = await payment(2000, "2026-02-01T10:00:00Z");
      const entry = async (
        paymentId: string,
        instalmentId: string,
        receivedOn: string,
        from: string,
        to: string,
        collected: number,
      ) =>
        (
          await tx<{ id: string }[]>`
            INSERT INTO app.ai_programme_revenue_share_entries (
              school_id, license_id, invoice_id, payment_id, instalment_id, received_on,
              period_from, period_to, measurement_period_start, currency_id, collected_minor,
              base_minor, commitment, ai_programme_version_id, snapshot_id, seats, conversion_bps,
              conversion_share_bps, floor_applied, upload_consistency_bps, bonus_bps, capped,
              multiplier_bps, total_bps, amount_minor, conversion_pending, bonus_pending, status
            ) VALUES (
              ${schoolId}::uuid, ${lic}::uuid, ${invoice!.id}::uuid, ${paymentId}::uuid,
              ${instalmentId}::uuid, ${receivedOn}, ${from}, ${to}, '2026-01-01', ${usd}::uuid,
              ${collected}, ${collected}, 'full_year', ${PROGRAMME_V1}::uuid, ${snapshot!.id}::uuid,
              10, 7000, 1000, false, 8500, 300, false, 10000, 1300, ${(collected * 13) / 100},
              false, false, 'owed'
            )
            RETURNING id::text AS id
          `
        )[0]!.id;
      return {
        paid: await entry(paidFirst, first!.id, "2026-01-01", "2026-01-01", "2026-01-31", 4000),
        half: await entry(paidHalf, second!.id, "2026-02-01", "2026-02-01", "2026-02-28", 2000),
      };
    });

    const statuses = () =>
      admin(
        schoolId,
        (tx) => tx<{ id: string; status: string; forfeit_reason: string | null }[]>`
          SELECT id::text AS id, status, forfeit_reason FROM app.ai_programme_revenue_share_entries
          WHERE school_id = ${schoolId}::uuid ORDER BY received_on
        `,
      );

    // Day 29 after month 2's due date: the AI runs, every share stands.
    const day29 = await runLicenseLifecycle(db!, new Date("2026-03-02T12:00:00Z"), silentLogger, [
      schoolId,
    ]);
    expect(day29).toMatchObject({ licensesStopped: 0, sharesSettled: 0 });
    // Day 30: the AI stops, and the unpaid month's share is forfeited.
    const day30 = await runLicenseLifecycle(db!, new Date("2026-03-03T00:30:00Z"), silentLogger, [
      schoolId,
    ]);
    expect(day30).toMatchObject({
      licensesStopped: 1,
      sharesSettled: 1,
      failedRevenueShareSchools: 0,
    });
    expect([...(await statuses())]).toEqual([
      { id: ids.paid, status: "owed", forfeit_reason: null },
      { id: ids.half, status: "forfeited", forfeit_reason: "unpaid_at_cutoff" },
    ]);
    const [audit] = await admin(
      schoolId,
      (tx) => tx<{ v: string }[]>`
        SELECT new_values ->> 'status' AS v FROM app.audit_logs
        WHERE school_id = ${schoolId}::uuid AND target_table = 'ai_programme_revenue_share_entries'
          AND target_id = ${ids.half}::uuid
      `,
    );
    expect(audit!.v).toBe("forfeited");
    // Idempotent.
    const again = await runLicenseLifecycle(db!, new Date("2026-03-03T01:30:00Z"), silentLogger, [
      schoolId,
    ]);
    expect(again.sharesSettled).toBe(0);
  });
});
