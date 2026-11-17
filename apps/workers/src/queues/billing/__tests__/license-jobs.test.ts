/**
 * The school license jobs against a real database (migrations 000163-000166): the lifecycle run
 * (licenses and quotes expire, invoices go overdue), the reminders (each once, to the right people,
 * in the right school) and the monthly usage-period start. Needs TEST_DATABASE_URL pointing at a
 * fully migrated database, like the other billing job tests.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runLicenseLifecycle } from "../license-lifecycle";
import { formatMoney, runLicenseReminders } from "../license-reminders";
import { monthStart, runUsagePeriodStart } from "../usage-period-start";

import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const jobTest = test.skipIf(!enabled);

const DAY = 86_400_000;
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let db: Sql | undefined;
let usd = "";
let jo = "";
let tier = "";
let hq = { schoolId: "", superAdmin: "" };

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
    // Rank is unique among active tiers of an audience; a random one keeps re-runs on one database apart.
    const code = `student_jobs_${crypto.randomUUID().slice(0, 8)}`;
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES (${code}, 'Student Jobs', 'student', ${100 + Math.floor(Math.random() * 30_000)})
      RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.plan_features (plan_id, feature_key, monthly_limit) VALUES
        (${plan!.id}::uuid, 'ai_tutor', 300), (${plan!.id}::uuid, 'study_tools', 50)
    `;
    tier = plan!.id;
  });
  const home = await school("Studafy HQ (jobs)");
  // Only a platform school may hold SUPER_ADMIN (000185).
  await admin(
    null,
    (tx) => tx`UPDATE app.schools SET is_platform_tenant = true WHERE id = ${home}::uuid`,
  );
  const superAdmin = await user(home, "SUPER_ADMIN");
  hq = { schoolId: home, superAdmin };
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

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

async function school(name = "Jobs School"): Promise<string> {
  const slug = `jobs-${crypto.randomUUID().slice(0, 8)}`;
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
    const email = `${crypto.randomUUID().slice(0, 8)}@jobs.local`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${email}, ${email}, 'Jobs User', 'active')
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
      VALUES (${schoolId}::uuid, ${userId}::uuid, ${`ADM-${crypto.randomUUID().slice(0, 8)}`}, 'Job', 'Student', 'enrolled')
      RETURNING id::text AS id
    `;
    return { userId, studentId: row!.id };
  });
}

async function license(
  schoolId: string,
  options: { status?: string; startsAt: Date; endsAt: Date; seats?: number; graceDays?: number },
): Promise<string> {
  return admin(schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.school_licenses (
        school_id, status, starts_at, ends_at, student_plan_id, student_seats, currency_id,
        created_by, activated_at, ai_programme_version_id, nonpayment_grace_days
      ) VALUES (
        ${schoolId}::uuid, ${options.status ?? "active"}, ${options.startsAt}, ${options.endsAt}, ${tier}::uuid,
        ${options.seats ?? 5}, ${usd}::uuid, ${hq.superAdmin}::uuid, ${options.startsAt},
        -- The approved defaults (000234), with the licence's grace period.
        'a1000000-0000-4000-8000-000000000001'::uuid, ${options.graceDays ?? 30}
      )
      RETURNING id::text AS id
    `;
    return row!.id;
  });
}

async function seat(
  schoolId: string,
  licenseId: string,
  holder: { userId: string; studentId: string },
) {
  await admin(
    schoolId,
    (tx) => tx`
    INSERT INTO app.license_seats (school_id, license_id, audience, user_id, student_id, assigned_by)
    VALUES (${schoolId}::uuid, ${licenseId}::uuid, 'student', ${holder.userId}::uuid,
            ${holder.studentId}::uuid, ${hq.superAdmin}::uuid)
  `,
  );
}

const reference = () =>
  `STF-${crypto.randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 4).toUpperCase()}`;

async function invoice(
  schoolId: string,
  licenseId: string,
  options: { dueDate: string; total?: number; paid?: number; overdueAt?: Date },
): Promise<string> {
  const total = options.total ?? 324_000;
  const paid = options.paid ?? 0;
  const status = paid === 0 ? "issued" : paid >= total ? "paid" : "partially_paid";
  return admin(schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.license_invoices (
        school_id, license_id, number, payment_reference, currency_id, issue_date, due_date,
        subtotal_minor, total_minor, paid_minor, status, overdue_at, issued_by
      ) VALUES (
        ${schoolId}::uuid, ${licenseId}::uuid, app.next_license_invoice_number(${options.dueDate}::date),
        ${reference()}, ${usd}::uuid, ${options.dueDate}::date - 30, ${options.dueDate}::date,
        ${total}, ${total}, ${paid}, ${status}, ${options.overdueAt ?? null}, ${hq.superAdmin}::uuid
      )
      RETURNING id::text AS id
    `;
    // Every invoice is paid in instalments (000221): one, with the invoice's own id, as the migration
    // gives every invoice issued before them.
    await tx`
      INSERT INTO app.license_invoice_instalments (
        id, school_id, invoice_id, position, amount_minor, paid_minor, due_date, status, overdue_at
      ) VALUES (
        ${row!.id}::uuid, ${schoolId}::uuid, ${row!.id}::uuid, 1, ${total}, ${paid},
        ${options.dueDate}::date, ${status === "issued" ? "due" : status}, ${options.overdueAt ?? null}
      )
    `;
    return row!.id;
  });
}

async function quote(
  schoolId: string,
  status: "draft" | "sent",
  validUntil: Date,
): Promise<string> {
  return admin(schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.license_quotes (
        school_id, kind, status, currency_id, starts_at, ends_at, months, student_plan_id,
        student_seats, list_total_minor, discount_total_minor, credit_total_minor, total_minor,
        breakdown, valid_until, created_by, sent_at
      ) VALUES (
        ${schoolId}::uuid, 'new', ${status}, ${usd}::uuid, now(), now() + interval '1 year', 12,
        ${tier}::uuid, 5, 180000, 18000, 0, 162000, '{"lines": []}'::jsonb, ${validUntil},
        ${hq.superAdmin}::uuid, ${status === "sent" ? new Date() : null}
      )
      RETURNING id::text AS id
    `;
    return row!.id;
  });
}

async function scalar<T>(
  schoolId: string,
  query: (tx: TransactionSql) => Promise<{ v: T }[]>,
): Promise<T> {
  return admin(schoolId, async (tx) => (await query(tx))[0]!.v);
}

// ---------------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------------

describe("license lifecycle", () => {
  jobTest("expires ended licenses, bumps their seat holders, and is idempotent", async () => {
    const schoolId = await school();
    const now = new Date();
    const ended = await license(schoolId, {
      startsAt: new Date(now.getTime() - 400 * DAY),
      endsAt: new Date(now.getTime() - DAY),
    });
    const suspendedEnded = await license(schoolId, {
      status: "suspended",
      startsAt: new Date(now.getTime() - 400 * DAY),
      endsAt: new Date(now.getTime() - 2 * DAY),
    });
    const holder = await student(schoolId);
    await seat(schoolId, ended, holder);

    const result = await runLicenseLifecycle(db!, now, silentLogger, [schoolId]);
    expect(result).toMatchObject({ licensesExpired: 2, entitlementBumps: 1, failedSchools: 0 });

    const statuses = await admin(
      schoolId,
      (tx) => tx<{ id: string; status: string }[]>`
      SELECT id::text AS id, status FROM app.school_licenses WHERE school_id = ${schoolId}::uuid
    `,
    );
    expect(new Map(statuses.map((s) => [s.id, s.status]))).toEqual(
      new Map([
        [ended, "expired"],
        [suspendedEnded, "expired"],
      ]),
    );
    const version = await scalar(
      schoolId,
      (tx) => tx<{ v: string }[]>`
      SELECT version::text AS v FROM app.entitlement_versions
      WHERE subject_type = 'user' AND subject_id = ${holder.userId}::uuid
    `,
    );
    expect(Number(version)).toBeGreaterThanOrEqual(2);
    const events = await scalar(
      schoolId,
      (tx) => tx<{ v: number }[]>`
      SELECT count(*)::int AS v FROM app.outbox_events
      WHERE event_name = 'userEntitlement.changed' AND payload ->> 'userId' = ${holder.userId}
    `,
    );
    expect(events).toBe(1);
    const audits = await scalar(
      schoolId,
      (tx) => tx<{ v: number }[]>`
      SELECT count(*)::int AS v FROM app.audit_logs
      WHERE target_table = 'school_licenses' AND new_values ->> 'status' = 'expired' AND actor_id IS NULL
    `,
    );
    expect(audits).toBe(2);

    const again = await runLicenseLifecycle(db!, now, silentLogger, [schoolId]);
    expect(again).toMatchObject({ licensesExpired: 0, entitlementBumps: 0 });
  });

  jobTest(
    "leaves a running license alone and keeps its AI while an unpaid invoice is under 30 days late",
    async () => {
      const schoolId = await school();
      const now = new Date();
      const running = await license(schoolId, {
        startsAt: new Date(now.getTime() - DAY),
        endsAt: new Date(now.getTime() + 100 * DAY),
      });
      // 29 days late: overdue, but the AI only stops on day 30 (000233; see the cutoff tests below).
      await invoice(schoolId, running, {
        dueDate: new Date(now.getTime() - 29 * DAY).toISOString().slice(0, 10),
      });

      await runLicenseLifecycle(db!, now, silentLogger, [schoolId]);
      expect(
        await scalar(
          schoolId,
          (tx) =>
            tx<
              { v: string }[]
            >`SELECT status AS v FROM app.school_licenses WHERE id = ${running}::uuid`,
        ),
      ).toBe("active");
    },
  );

  jobTest("expires sent quotes past their valid-until date, not drafts", async () => {
    const schoolId = await school();
    const now = new Date();
    const stale = await quote(schoolId, "sent", new Date(now.getTime() - DAY));
    const open = await quote(schoolId, "sent", new Date(now.getTime() + DAY));
    const draft = await quote(schoolId, "draft", new Date(now.getTime() - DAY));

    const result = await runLicenseLifecycle(db!, now, silentLogger, [schoolId]);
    expect(result.quotesExpired).toBe(1);
    const rows = await admin(
      schoolId,
      (tx) => tx<{ id: string; status: string; closed: boolean }[]>`
      SELECT id::text AS id, status, closed_at IS NOT NULL AS closed FROM app.license_quotes
      WHERE school_id = ${schoolId}::uuid
    `,
    );
    const byId = new Map(rows.map((r) => [r.id, [r.status, r.closed]]));
    expect(byId.get(stale)).toEqual(["expired", true]);
    expect(byId.get(open)).toEqual(["sent", false]);
    expect(byId.get(draft)).toEqual(["draft", false]);
  });

  jobTest("marks unpaid invoices past due overdue, once", async () => {
    const schoolId = await school();
    const now = new Date();
    const lic = await license(schoolId, {
      startsAt: new Date(now.getTime() - DAY),
      endsAt: new Date(now.getTime() + 300 * DAY),
    });
    const yesterday = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    const late = await invoice(schoolId, lic, { dueDate: yesterday });
    const partly = await invoice(schoolId, lic, { dueDate: yesterday, paid: 1000 });
    const paid = await invoice(schoolId, lic, { dueDate: yesterday, paid: 324_000 });
    const dueToday = await invoice(schoolId, lic, { dueDate: today });

    const result = await runLicenseLifecycle(db!, now, silentLogger, [schoolId]);
    expect(result.invoicesOverdue).toBe(2);
    const rows = await admin(
      schoolId,
      (tx) => tx<{ id: string; overdue: boolean; status: string }[]>`
      SELECT id::text AS id, overdue_at IS NOT NULL AS overdue, status FROM app.license_invoices
      WHERE school_id = ${schoolId}::uuid
    `,
    );
    const byId = new Map(rows.map((r) => [r.id, [r.overdue, r.status]]));
    expect(byId.get(late)).toEqual([true, "issued"]);
    expect(byId.get(partly)).toEqual([true, "partially_paid"]);
    expect(byId.get(paid)).toEqual([false, "paid"]);
    expect(byId.get(dueToday)).toEqual([false, "issued"]);

    expect((await runLicenseLifecycle(db!, now, silentLogger, [schoolId])).invoicesOverdue).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------------------

async function notifications(schoolId: string, userId: string) {
  return admin(
    schoolId,
    (tx) => tx<{ type: string; title: string; body: string; kind: string }[]>`
    SELECT notification_type::text AS type, title, body, metadata ->> 'kind' AS kind
    FROM app.notifications
    WHERE school_id = ${schoolId}::uuid AND user_id = ${userId}::uuid
    ORDER BY created_at, id
  `,
  );
}

describe("license reminders", () => {
  jobTest(
    "30 and 7 days before expiry, to the school's admins and principals and the super admins",
    async () => {
      const schoolId = await school("Amman Academy");
      const orgAdmin = await user(schoolId, "ORG_ADMIN");
      const principal = await user(schoolId, "PRINCIPAL");
      const teacher = await user(schoolId, "INSTRUCTOR");
      const now = new Date();
      const lic = await license(schoolId, {
        startsAt: new Date(now.getTime() - 300 * DAY),
        endsAt: new Date(now.getTime() + 20 * DAY),
      });

      const first = await runLicenseReminders(db!, now, silentLogger, [schoolId]);
      expect(first.reminders.license_expiring_30).toBe(1);
      // ORG_ADMIN, PRINCIPAL and the super admin (in their own school).
      expect(first.notifications).toBeGreaterThanOrEqual(3);
      for (const id of [orgAdmin, principal]) {
        const [notice] = await notifications(schoolId, id);
        expect(notice).toMatchObject({ type: "LICENSE_EXPIRING", kind: "license_expiring_30" });
        expect(notice!.body).toContain("Amman Academy's Studafy license ends on");
        expect(notice!.body).toContain("in 20 days");
      }
      expect(await notifications(schoolId, teacher)).toHaveLength(0);
      const superNotices = await notifications(hq.schoolId, hq.superAdmin);
      expect(
        superNotices.some(
          (n) => n.kind === "license_expiring_30" && n.body.includes("Amman Academy"),
        ),
      ).toBe(true);

      // Sent once.
      expect(
        (await runLicenseReminders(db!, now, silentLogger, [schoolId])).reminders
          .license_expiring_30,
      ).toBe(0);
      expect(await notifications(schoolId, orgAdmin)).toHaveLength(1);

      // Two weeks later: the 7-day reminder.
      const later = new Date(now.getTime() + 14 * DAY);
      const second = await runLicenseReminders(db!, later, silentLogger, [schoolId]);
      expect(second.reminders.license_expiring_7).toBe(1);
      const notices = await notifications(schoolId, orgAdmin);
      expect(notices.map((n) => n.kind)).toEqual(["license_expiring_30", "license_expiring_7"]);
      expect(notices[1]!.body).toContain("in 6 days");
      void lic;
    },
  );

  jobTest("an invoice due today, then overdue; a receipt to the super admins only", async () => {
    const schoolId = await school("Zarqa School");
    const orgAdmin = await user(schoolId, "ORG_ADMIN");
    const now = new Date();
    const lic = await license(schoolId, {
      startsAt: new Date(now.getTime() - DAY),
      endsAt: new Date(now.getTime() + 300 * DAY),
    });
    const id = await invoice(schoolId, lic, {
      dueDate: now.toISOString().slice(0, 10),
      total: 437_400,
      paid: 100_000,
    });
    const number = await scalar(
      schoolId,
      (tx) =>
        tx<{ v: string }[]>`SELECT number AS v FROM app.license_invoices WHERE id = ${id}::uuid`,
    );

    const due = await runLicenseReminders(db!, now, silentLogger, [schoolId]);
    expect(due.reminders.invoice_due).toBe(1);
    const [notice] = await notifications(schoolId, orgAdmin);
    expect(notice).toMatchObject({ type: "LICENSE_INVOICE_DUE", kind: "invoice_due" });
    expect(notice!.body).toContain(number);
    expect(notice!.body).toContain("Balance: 3374.00 USD");

    // The next day the lifecycle job marks it overdue; the reminder follows.
    const tomorrow = new Date(now.getTime() + DAY);
    await runLicenseLifecycle(db!, tomorrow, silentLogger, [schoolId]);
    const overdue = await runLicenseReminders(db!, tomorrow, silentLogger, [schoolId]);
    expect(overdue.reminders).toMatchObject({ invoice_due: 0, invoice_overdue: 1 });
    expect((await notifications(schoolId, orgAdmin)).map((n) => n.type)).toEqual([
      "LICENSE_INVOICE_DUE",
      "LICENSE_INVOICE_OVERDUE",
    ]);

    // A receipt the school uploaded: the super admins hear of it, the school does not.
    const [receipt] = await admin(
      schoolId,
      (tx) => tx<{ id: string }[]>`
      INSERT INTO app.license_payment_receipts (
        school_id, invoice_id, storage_key, file_name, content_type, size_bytes, uploaded_by
      ) VALUES (
        ${schoolId}::uuid, ${id}::uuid, ${`permanent/${schoolId}/r/receipt.pdf`}, 'receipt.pdf',
        'application/pdf', 1000, ${orgAdmin}::uuid
      )
      RETURNING id::text AS id
    `,
    );
    const uploaded = await runLicenseReminders(db!, tomorrow, silentLogger, [schoolId]);
    expect(uploaded.reminders.receipt_uploaded).toBe(1);
    expect(
      (await notifications(schoolId, orgAdmin)).some((n) => n.type === "LICENSE_RECEIPT_UPLOADED"),
    ).toBe(false);
    const superNotices = await notifications(hq.schoolId, hq.superAdmin);
    expect(
      superNotices.some(
        (n) =>
          n.type === "LICENSE_RECEIPT_UPLOADED" &&
          n.body.includes("Zarqa School") &&
          n.body.includes(number),
      ),
    ).toBe(true);

    const ledger = await admin(
      schoolId,
      (tx) => tx<{ kind: string }[]>`
      SELECT kind FROM app.license_reminders WHERE school_id = ${schoolId}::uuid ORDER BY sent_at, kind
    `,
    );
    expect(ledger.map((l) => l.kind).sort()).toEqual([
      "invoice_due",
      "invoice_overdue",
      "receipt_uploaded",
    ]);
    void receipt;
  });

  test("money is printed in major units at the currency's precision", () => {
    expect(formatMoney(337_400, 2, "USD")).toBe("3374.00 USD");
    expect(formatMoney(1_950_000, 3, "JOD")).toBe("1950.000 JOD");
  });
});

// ---------------------------------------------------------------------------------------------------
// Usage periods
// ---------------------------------------------------------------------------------------------------

describe("usage period start", () => {
  jobTest(
    "opens a zero meter per seat holder and metered feature of their tier, once",
    async () => {
      const schoolId = await school();
      const now = new Date();
      const lic = await license(schoolId, {
        startsAt: new Date(now.getTime() - DAY),
        endsAt: new Date(now.getTime() + 300 * DAY),
      });
      const holders = [await student(schoolId), await student(schoolId)];
      for (const holder of holders) await seat(schoolId, lic, holder);

      const result = await runUsagePeriodStart(db!, now, silentLogger, [schoolId]);
      // Two holders x the tier's two metered features (ai_tutor, study_tools).
      expect(result).toMatchObject({
        metersOpened: 4,
        periodStart: monthStart(now),
        failedSchools: 0,
      });
      const meters = await admin(
        schoolId,
        (tx) => tx<{ feature_key: string; used: string; period: string }[]>`
      SELECT feature_key, used::text AS used, period_start::text AS period FROM app.feature_usage_meters
      WHERE school_id = ${schoolId}::uuid ORDER BY feature_key
    `,
      );
      expect(meters.map((m) => [m.feature_key, m.used, m.period])).toEqual([
        ["ai_tutor", "0", monthStart(now)],
        ["ai_tutor", "0", monthStart(now)],
        ["study_tools", "0", monthStart(now)],
        ["study_tools", "0", monthStart(now)],
      ]);

      expect((await runUsagePeriodStart(db!, now, silentLogger, [schoolId])).metersOpened).toBe(0);
    },
  );

  test("the period is the first of the month in UTC", () => {
    expect(monthStart(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11-01");
    expect(monthStart(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01-01");
  });
});

// ---------------------------------------------------------------------------------------------------

describe("instalments (000221)", () => {
  jobTest("each unpaid instalment goes overdue and is reminded of on its own", async () => {
    const schoolId = await school("Instalment School");
    const orgAdmin = await user(schoolId, "ORG_ADMIN");
    const now = new Date();
    const lic = await license(schoolId, {
      startsAt: new Date(now.getTime() - 40 * DAY),
      endsAt: new Date(now.getTime() + 200 * DAY),
    });
    const yesterday = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
    const later = new Date(now.getTime() + 30 * DAY).toISOString().slice(0, 10);
    // Two monthly instalments of 1000.00: the first is late, the second not yet due.
    const id = await invoice(schoolId, lic, { dueDate: yesterday, total: 200_000 });
    const second = crypto.randomUUID();
    await admin(schoolId, async (tx) => {
      await tx`
        UPDATE app.license_invoice_instalments SET amount_minor = 100_000
        WHERE school_id = ${schoolId}::uuid AND invoice_id = ${id}::uuid
      `;
      await tx`
        INSERT INTO app.license_invoice_instalments (
          id, school_id, invoice_id, position, amount_minor, due_date, status
        ) VALUES (${second}::uuid, ${schoolId}::uuid, ${id}::uuid, 2, 100_000, ${later}::date, 'due')
      `;
    });

    await runLicenseLifecycle(db!, now, silentLogger, [schoolId]);
    const marked = await admin(
      schoolId,
      (tx) => tx<{ position: number; overdue: boolean }[]>`
        SELECT position, overdue_at IS NOT NULL AS overdue FROM app.license_invoice_instalments
        WHERE school_id = ${schoolId}::uuid AND invoice_id = ${id}::uuid ORDER BY position
      `,
    );
    expect(marked.map((row) => [row.position, row.overdue])).toEqual([
      [1, true],
      [2, false],
    ]);

    const sent = await runLicenseReminders(db!, now, silentLogger, [schoolId]);
    expect(sent.reminders).toMatchObject({ invoice_due: 0, invoice_overdue: 1 });
    const [notice] = await notifications(schoolId, orgAdmin);
    expect(notice).toMatchObject({ type: "LICENSE_INVOICE_OVERDUE" });
    expect(notice!.body).toContain("Balance: 1000.00 USD");
    expect((await runLicenseReminders(db!, now, silentLogger, [schoolId])).reminders).toMatchObject(
      {
        invoice_overdue: 0,
      },
    );
  });

  jobTest("an invoice whose instalments do not add up cannot be stored", async () => {
    const schoolId = await school();
    const now = new Date();
    const lic = await license(schoolId, {
      startsAt: new Date(now.getTime() - DAY),
      endsAt: new Date(now.getTime() + 200 * DAY),
    });
    const id = await invoice(schoolId, lic, { dueDate: now.toISOString().slice(0, 10) });
    const failure = await admin(schoolId, async (tx) => {
      await tx`
        UPDATE app.license_invoice_instalments SET amount_minor = 1
        WHERE school_id = ${schoolId}::uuid AND invoice_id = ${id}::uuid
      `;
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain("is not whole");
  });
});

// ---------------------------------------------------------------------------------------------------
// AI stops 30 days after an unpaid instalment (000233)
// ---------------------------------------------------------------------------------------------------

describe("AI stops 30 days after an unpaid instalment (000233)", () => {
  /** An open invoice on `lic` in instalments of `amount` due on each of `dueDates`. */
  async function instalments(
    schoolId: string,
    lic: string,
    dueDates: string[],
    amount = 100_000,
  ): Promise<{ invoiceId: string; ids: string[] }> {
    const invoiceId = await invoice(schoolId, lic, {
      dueDate: dueDates[0]!,
      total: amount * dueDates.length,
    });
    const ids = [invoiceId];
    await admin(schoolId, async (tx) => {
      await tx`
        UPDATE app.license_invoice_instalments SET amount_minor = ${amount}
        WHERE school_id = ${schoolId}::uuid AND invoice_id = ${invoiceId}::uuid
      `;
      for (const [index, dueDate] of dueDates.slice(1).entries()) {
        const id = crypto.randomUUID();
        ids.push(id);
        await tx`
          INSERT INTO app.license_invoice_instalments (
            id, school_id, invoice_id, position, amount_minor, due_date, status
          ) VALUES (${id}::uuid, ${schoolId}::uuid, ${invoiceId}::uuid, ${index + 2}, ${amount},
                    ${dueDate}::date, 'due')
        `;
      }
    });
    return { invoiceId, ids };
  }

  /** Pay the first `count` instalments of `amount` in full, as the API's allocation would. */
  async function payFirst(schoolId: string, invoiceId: string, count: number, amount = 100_000) {
    await admin(schoolId, async (tx) => {
      const [row] = await tx<{ total: string }[]>`
        SELECT total_minor::text AS total FROM app.license_invoices
        WHERE school_id = ${schoolId}::uuid AND id = ${invoiceId}::uuid
      `;
      const total = row!.total;
      const paid = count * amount;
      await tx`
        UPDATE app.license_invoice_instalments
        SET paid_minor = amount_minor, status = 'paid'
        WHERE school_id = ${schoolId}::uuid AND invoice_id = ${invoiceId}::uuid
          AND position <= ${count}
      `;
      await tx`
        UPDATE app.license_invoices
        SET paid_minor = ${paid},
            status = ${paid >= Number(total) ? "paid" : "partially_paid"}
        WHERE school_id = ${schoolId}::uuid AND id = ${invoiceId}::uuid
      `;
    });
  }

  async function state(schoolId: string, lic: string) {
    return admin(
      schoolId,
      async (tx) =>
        (
          await tx<{ status: string; stopped: boolean }[]>`
            SELECT status, nonpayment_suspended_at IS NOT NULL AS stopped
            FROM app.school_licenses WHERE school_id = ${schoolId}::uuid AND id = ${lic}::uuid
          `
        )[0]!,
    );
  }

  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const at = (iso: string, time: string) => new Date(`${iso}T${time}Z`);

  async function activeSchool() {
    const schoolId = await school("Cutoff School");
    const orgAdmin = await user(schoolId, "ORG_ADMIN");
    const lic = await license(schoolId, {
      startsAt: day("2026-01-01"),
      endsAt: day("2030-01-01"),
    });
    const holder = await student(schoolId);
    await seat(schoolId, lic, holder);
    return { schoolId, orgAdmin, lic };
  }

  jobTest("day 29 keeps the AI; day 30 stops it (UTC dates, whatever the hour)", async () => {
    const { schoolId, lic } = await activeSchool();
    await instalments(schoolId, lic, ["2026-03-01"]);

    // Due 1 March: 30 March is day 29 -- late in the UTC day still counts as day 29.
    const day29 = await runLicenseLifecycle(db!, at("2026-03-30", "23:59:59"), silentLogger, [
      schoolId,
    ]);
    expect(day29.licensesStopped).toBe(0);
    expect(await state(schoolId, lic)).toEqual({ status: "active", stopped: false });

    // 31 March is day 30: stopped from the first minute of the UTC day.
    const day30 = await runLicenseLifecycle(db!, at("2026-03-31", "00:00:01"), silentLogger, [
      schoolId,
    ]);
    expect(day30).toMatchObject({ licensesStopped: 1, failedSchools: 0 });
    expect(day30.entitlementBumps).toBeGreaterThanOrEqual(1);
    expect(await state(schoolId, lic)).toEqual({ status: "suspended", stopped: true });

    // Idempotent: nothing more to stop, nothing to resume.
    const again = await runLicenseLifecycle(db!, at("2026-03-31", "01:00:00"), silentLogger, [
      schoolId,
    ]);
    expect(again).toMatchObject({ licensesStopped: 0, licensesResumed: 0 });

    const audit = await admin(
      schoolId,
      (tx) => tx<{ v: string }[]>`
        SELECT new_values ->> 'reason' AS v FROM app.audit_logs
        WHERE school_id = ${schoolId}::uuid AND target_table = 'school_licenses'
          AND target_id = ${lic}::uuid AND new_values ->> 'status' = 'suspended'
      `,
    );
    expect(audit.map((row) => row.v)).toEqual(["non_payment"]);
  });

  jobTest("the licence's own grace period (000234) moves the cutoff", async () => {
    const schoolId = await school("Grace School");
    const lic = await license(schoolId, {
      startsAt: day("2026-01-01"),
      endsAt: day("2030-01-01"),
      graceDays: 45,
    });
    await instalments(schoolId, lic, ["2026-03-01"]);
    // Day 30 (31 March) no longer stops it ...
    const day30 = await runLicenseLifecycle(db!, day("2026-03-31"), silentLogger, [schoolId]);
    expect(day30.licensesStopped).toBe(0);
    // ... day 45 (15 April) does.
    const day45 = await runLicenseLifecycle(db!, day("2026-04-15"), silentLogger, [schoolId]);
    expect(day45.licensesStopped).toBe(1);
    expect(await state(schoolId, lic)).toEqual({ status: "suspended", stopped: true });
    // A longer grace re-applied to the licence (the super admin's choice) lets the job resume it.
    await admin(
      schoolId,
      (tx) => tx`
      UPDATE app.school_licenses SET nonpayment_grace_days = 60
      WHERE school_id = ${schoolId}::uuid AND id = ${lic}::uuid
    `,
    );
    const resumed = await runLicenseLifecycle(db!, day("2026-04-16"), silentLogger, [schoolId]);
    expect(resumed.licensesResumed).toBe(1);
  });

  jobTest("paying resumes it; a later instalment going unpaid stops it again", async () => {
    const { schoolId, lic } = await activeSchool();
    const { invoiceId } = await instalments(schoolId, lic, [
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
    ]);
    await runLicenseLifecycle(db!, day("2026-03-31"), silentLogger, [schoolId]);
    expect((await state(schoolId, lic)).stopped).toBe(true);

    // The first instalment paid: nothing is 30 days late on 2 April (the second is 1 day late).
    await payFirst(schoolId, invoiceId, 1);
    const resumed = await runLicenseLifecycle(db!, day("2026-04-02"), silentLogger, [schoolId]);
    expect(resumed.licensesResumed).toBe(1);
    expect(await state(schoolId, lic)).toEqual({ status: "active", stopped: false });

    // The second instalment, due 1 April, reaches day 30 on 1 May: stopped again.
    const second = await runLicenseLifecycle(db!, day("2026-05-01"), silentLogger, [schoolId]);
    expect(second.licensesStopped).toBe(1);
    expect(await state(schoolId, lic)).toEqual({ status: "suspended", stopped: true });

    await payFirst(schoolId, invoiceId, 2);
    expect(
      (await runLicenseLifecycle(db!, day("2026-05-02"), silentLogger, [schoolId])).licensesResumed,
    ).toBe(1);
  });

  jobTest("only the instalment past day 30 counts while another is merely overdue", async () => {
    const { schoolId, lic } = await activeSchool();
    const { invoiceId } = await instalments(schoolId, lic, ["2026-03-01", "2026-03-20"]);
    await payFirst(schoolId, invoiceId, 1);
    // 31 March: the first is paid, the second is 11 days late -- the AI keeps working.
    const run = await runLicenseLifecycle(db!, day("2026-03-31"), silentLogger, [schoolId]);
    expect(run.licensesStopped).toBe(0);
    expect(await state(schoolId, lic)).toEqual({ status: "active", stopped: false });
  });

  jobTest("a licence the super admin suspended by hand is never resumed by the job", async () => {
    const { schoolId, lic } = await activeSchool();
    await admin(
      schoolId,
      (tx) => tx`UPDATE app.school_licenses SET status = 'suspended' WHERE id = ${lic}::uuid`,
    );
    const run = await runLicenseLifecycle(db!, day("2026-03-31"), silentLogger, [schoolId]);
    expect(run).toMatchObject({ licensesStopped: 0, licensesResumed: 0 });
    expect(await state(schoolId, lic)).toEqual({ status: "suspended", stopped: false });
  });

  jobTest("leaving suspended clears the non-payment mark", async () => {
    const { schoolId, lic } = await activeSchool();
    await instalments(schoolId, lic, ["2026-03-01"]);
    await runLicenseLifecycle(db!, day("2026-03-31"), silentLogger, [schoolId]);
    await admin(
      schoolId,
      (tx) => tx`UPDATE app.school_licenses SET status = 'cancelled' WHERE id = ${lic}::uuid`,
    );
    expect(await state(schoolId, lic)).toEqual({ status: "cancelled", stopped: false });
  });

  jobTest("the school is warned a week before the cutoff, then told once it stops", async () => {
    const { schoolId, orgAdmin, lic } = await activeSchool();
    await instalments(schoolId, lic, ["2026-03-01"]);

    // 23 March: the cutoff (31 March) is 8 days away -- too early to warn.
    await runLicenseLifecycle(db!, day("2026-03-23"), silentLogger, [schoolId]);
    let sent = await runLicenseReminders(db!, day("2026-03-23"), silentLogger, [schoolId]);
    expect(sent.reminders).toMatchObject({ ai_stop_warning: 0, ai_stopped: 0 });

    // 24 March: 7 days left.
    sent = await runLicenseReminders(db!, day("2026-03-24"), silentLogger, [schoolId]);
    expect(sent.reminders).toMatchObject({ ai_stop_warning: 1, ai_stopped: 0 });
    // Once only.
    sent = await runLicenseReminders(db!, day("2026-03-25"), silentLogger, [schoolId]);
    expect(sent.reminders.ai_stop_warning).toBe(0);

    await runLicenseLifecycle(db!, day("2026-03-31"), silentLogger, [schoolId]);
    sent = await runLicenseReminders(db!, day("2026-03-31"), silentLogger, [schoolId]);
    expect(sent.reminders).toMatchObject({ ai_stopped: 1 });
    expect(
      (await runLicenseReminders(db!, day("2026-04-01"), silentLogger, [schoolId])).reminders,
    ).toMatchObject({ ai_stopped: 0, ai_stop_warning: 0 });

    const notices = (await notifications(schoolId, orgAdmin)).filter((n) =>
      n.type.startsWith("LICENSE_AI_"),
    );
    expect(notices.map((n) => [n.type, n.kind])).toEqual([
      ["LICENSE_AI_STOP_WARNING", "ai_stop_warning"],
      ["LICENSE_AI_STOPPED", "ai_stopped"],
    ]);
    expect(notices[0]!.body).toContain("2026-03-31");
    expect(notices[0]!.body).toContain("in 7 days");
  });
});

// ---------------------------------------------------------------------------------------------------
// Overdue-payment emails (000233)
// ---------------------------------------------------------------------------------------------------

describe("licence payment emails (000233)", () => {
  async function queued(schoolId: string) {
    return admin(
      schoolId,
      (tx) => tx<
        { email: string; kind: string; locale: string; payload: Record<string, unknown> }[]
      >`
        SELECT payload ->> 'email' AS email, payload ->> 'kind' AS kind,
               payload ->> 'locale' AS locale, payload
        FROM app.outbox_events
        WHERE school_id = ${schoolId}::uuid AND event_name = 'licenseInvoice.paymentEmail'
        ORDER BY id
      `,
    );
  }

  async function emailOf(schoolId: string, userId: string): Promise<string> {
    return scalar(
      schoolId,
      (tx) =>
        tx<{ v: string }[]>`SELECT normalized_email AS v FROM app.users WHERE id = ${userId}::uuid`,
    );
  }

  jobTest(
    "an overdue instalment is emailed once to the admins, principals and the school's verified address",
    async () => {
      const schoolId = await school("Email School");
      const orgAdmin = await user(schoolId, "ORG_ADMIN");
      const principal = await user(schoolId, "PRINCIPAL");
      await user(schoolId, "INSTRUCTOR");
      const schoolEmail = await admin(null, async (tx) => {
        const [row] = await tx<{ email: string }[]>`
          UPDATE app.schools SET email_verified_at = now() WHERE id = ${schoolId}::uuid
          RETURNING normalized_email AS email
        `;
        return row!.email;
      });
      await admin(
        schoolId,
        (tx) => tx`
          INSERT INTO app.school_settings (school_id, locale) VALUES (${schoolId}::uuid, 'ar')
          ON CONFLICT (school_id) DO UPDATE SET locale = 'ar'
        `,
      );
      const now = new Date();
      const lic = await license(schoolId, {
        startsAt: new Date(now.getTime() - 40 * DAY),
        endsAt: new Date(now.getTime() + 300 * DAY),
      });
      const yesterday = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
      const invoiceId = await invoice(schoolId, lic, { dueDate: yesterday, total: 25_000 });

      await runLicenseLifecycle(db!, now, silentLogger, [schoolId]);
      const sent = await runLicenseReminders(db!, now, silentLogger, [schoolId]);
      expect(sent.emails).toBe(3);

      const rows = await queued(schoolId);
      expect(rows.map((row) => row.email).sort()).toEqual(
        [await emailOf(schoolId, orgAdmin), await emailOf(schoolId, principal), schoolEmail].sort(),
      );
      expect(rows.every((row) => row.kind === "instalment_overdue" && row.locale === "ar")).toBe(
        true,
      );
      expect(rows[0]!.payload).toMatchObject({
        invoiceId,
        instalmentId: invoiceId,
        instalmentPosition: 1,
        instalmentCount: 1,
        amount: "250.00 USD",
        dueDate: yesterday,
        stopDate: new Date(Date.parse(`${yesterday}T00:00:00Z`) + 30 * DAY)
          .toISOString()
          .slice(0, 10),
        paymentLink: null,
      });
      // No student data in a billing email.
      expect(JSON.stringify(rows[0]!.payload)).not.toContain("student");

      // Re-runs queue nothing more.
      expect((await runLicenseReminders(db!, now, silentLogger, [schoolId])).emails).toBe(0);
      expect(await queued(schoolId)).toHaveLength(3);
    },
  );

  jobTest("the 7-day warning and the stop are each emailed once", async () => {
    const schoolId = await school("Cutoff Email School");
    await user(schoolId, "ORG_ADMIN");
    const lic = await license(schoolId, {
      startsAt: new Date("2026-01-01T00:00:00Z"),
      endsAt: new Date("2030-01-01T00:00:00Z"),
    });
    await invoice(schoolId, lic, { dueDate: "2026-03-01", total: 100_000 });

    const at = (day: string) => new Date(`${day}T00:00:00Z`);
    await runLicenseLifecycle(db!, at("2026-03-24"), silentLogger, [schoolId]);
    await runLicenseReminders(db!, at("2026-03-24"), silentLogger, [schoolId]);
    await runLicenseReminders(db!, at("2026-03-25"), silentLogger, [schoolId]);
    await runLicenseLifecycle(db!, at("2026-03-31"), silentLogger, [schoolId]);
    await runLicenseReminders(db!, at("2026-03-31"), silentLogger, [schoolId]);
    await runLicenseReminders(db!, at("2026-04-01"), silentLogger, [schoolId]);

    expect((await queued(schoolId)).map((row) => row.kind)).toEqual([
      "instalment_overdue",
      "ai_stop_warning",
      "ai_stopped",
    ]);
  });
});
