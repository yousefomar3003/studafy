/**
 * The school chooses its licence length and payment plan (migration 000231, docs/adr/0021): the
 * request carries the months, start and plan (a custom plan as dates and shares); the super admin's
 * quote starts from it and needs a reason to depart from it; accepting the quote resolves the request;
 * the yearly plan and per-year totals; and the AI resuming the moment the payment that settles a
 * 30-day-late instalment is recorded.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import {
  acceptQuote,
  createChangeRequest,
  createQuote,
  recordPayment,
  replacePriceSettings,
  runLicenseChange,
  sendQuote,
  transitionLicense,
  writeBankDetails,
} from "../../src/modules/licensing";
import { inSchool } from "../../src/modules/licensing/context";
import { requireInvoiceDetail } from "../../src/modules/licensing/invoices";
import { replaceQuote } from "../../src/modules/licensing/quotes";
import { licenseView, readLicense } from "../../src/modules/licensing/service";
import {
  assignRole,
  createSchool,
  createStudent,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { LicenseActor, LicensingDeps, QuoteTerms } from "../../src/modules/licensing";
import type { TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });
const DAY = 86_400_000;

let db: TestDatabase;
let hq: string;
let operator: LicenseActor;
const tiers = { student: "", teacher: "" };

function deps(): LicensingDeps {
  return {
    database: db.sql,
    redis: null,
    logger,
    providers: { stripe: null, googlePlay: null },
    storage: null,
  };
}

async function asAdmin<T>(
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

/** A change in a school as `actor`, through the same flow the routes use. */
function as<T>(
  schoolId: string,
  actor: LicenseActor,
  fn: (tx: TransactionSql) => Promise<{ result: T; versions?: Map<string, number>; pending?: [] }>,
) {
  return runLicenseChange(deps(), schoolId, actor, async (tx) => {
    const changed = await fn(tx);
    return {
      result: changed.result,
      versions: changed.versions ?? new Map(),
      pending: changed.pending ?? [],
    };
  }).then((r) => r.result);
}

/** The coded error a call is refused with. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return "no refusal";
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);

  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "billing-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  await asAdmin(null, async (tx) => {
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_plus_bill', 'Student Plus', 'student', 2) RETURNING id::text AS id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank, includes_all_features)
      VALUES ('teacher_pro_bill', 'Teacher Pro', 'teacher', 1, true) RETURNING id::text AS id
    `;
    await tx`INSERT INTO app.plan_features (plan_id, feature_key, monthly_limit) VALUES (${student!.id}::uuid, 'ai_tutor', 300)`;
    // 30.00 and 50.00 USD per seat per month.
    await tx`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
      SELECT ${student!.id}::uuid, id, 'monthly'::app.billing_interval, 3000 FROM app.currencies WHERE code = 'USD'
      UNION ALL
      SELECT ${teacher!.id}::uuid, id, 'monthly'::app.billing_interval, 5000 FROM app.currencies WHERE code = 'USD'
    `;
    tiers.student = student!.id;
    tiers.teacher = teacher!.id;

    // The house price list: 100+ seats 10%, 500+ 20%; 12 months 10%, 24 months 15%.
    await replacePriceSettings(
      tx,
      "USD",
      {
        volumeBasis: "per_audience",
        volumeBrackets: [
          { audience: null, minSeats: 1, discountBps: 0 },
          { audience: null, minSeats: 100, discountBps: 1000 },
          { audience: null, minSeats: 500, discountBps: 2000 },
        ],
        durationDiscounts: [
          { minMonths: 12, discountBps: 1000 },
          { minMonths: 24, discountBps: 1500 },
        ],
      },
      operator,
    );
    await writeBankDetails(
      tx,
      {
        bankName: "Arab Bank",
        accountName: "Studafy FZ-LLC",
        iban: "JO94CBJO0010000000000131000302",
        swift: "ARABJOAX",
        currencyCode: "USD",
      },
      operator,
    );
  });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

interface SchoolFixture {
  schoolId: string;
  admin: LicenseActor;
  students: { id: string; userId: string }[];
}

async function school(students = 0, name = "Billing School"): Promise<SchoolFixture> {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, "ORG_ADMIN");
  const created = [];
  for (let i = 0; i < students; i += 1) {
    const s = await createStudent(db.sql, schoolId, {
      firstName: "Bill",
      lastName: `Student ${i}`,
    });
    created.push({ id: s.id, userId: s.userId });
  }
  return {
    schoolId,
    admin: { kind: "school", userId: admin.id, homeSchoolId: schoolId },
    students: created,
  };
}

const newTerm = (seats: number, overrides: Partial<QuoteTerms> = {}): QuoteTerms => ({
  kind: "new",
  currencyCode: "USD",
  months: 12,
  student: { planId: tiers.student, seats },
  ...overrides,
});

async function sentQuote(f: SchoolFixture, terms: QuoteTerms, now?: Date) {
  return as(f.schoolId, operator, async (tx) => {
    const quote = await createQuote(tx, f.schoolId, terms, operator, now);
    return { result: await sendQuote(tx, f.schoolId, quote.id, operator, now) };
  });
}

async function accepted(f: SchoolFixture, quoteId: string, actor = f.admin, now?: Date) {
  return as(
    f.schoolId,
    actor,
    (tx) => acceptQuote(tx, f.schoolId, quoteId, actor, now) as never,
  ) as Promise<Awaited<ReturnType<typeof acceptQuote>>["result"]>;
}

async function pay(f: SchoolFixture, invoiceId: string, amountMinor: number, extra = {}) {
  return as(
    f.schoolId,
    operator,
    (tx) =>
      recordPayment(
        tx,
        f.schoolId,
        invoiceId,
        { amountMinor, receivedAt: new Date(), bankReference: `FT${amountMinor}`, ...extra },
        operator,
      ) as never,
  ) as Promise<Awaited<ReturnType<typeof recordPayment>>["result"]>;
}

async function licenseStatus(schoolId: string, licenseId: string) {
  return asAdmin(schoolId, async (tx) => (await readLicense(tx, licenseId))!.status);
}

const ISO = (date: Date) => date.toISOString().slice(0, 10);

async function detail(f: SchoolFixture, invoiceId: string) {
  return inSchool(db.sql, f.schoolId, f.admin, (tx) =>
    requireInvoiceDetail(tx, invoiceId, f.admin),
  );
}

const plusDays = (days: number) => ISO(new Date(Date.now() + days * DAY));

async function request(
  f: SchoolFixture,
  input: Partial<Parameters<typeof createChangeRequest>[2]> & { studentSeats?: number },
) {
  return as(f.schoolId, f.admin, async (tx) => ({
    result: await createChangeRequest(
      tx,
      f.schoolId,
      { note: "AI for our students", studentPlanId: tiers.student, ...input },
      f.admin,
    ),
  }));
}

async function quoteFor(f: SchoolFixture, terms: Parameters<typeof createQuote>[2]) {
  return as(f.schoolId, operator, async (tx) => ({
    result: await createQuote(tx, f.schoolId, terms, operator),
  }));
}

describe("the school's request", () => {
  integrationTest("carries the months, start and plan the school chose", async () => {
    const f = await school();
    const start = plusDays(10);
    const made = await request(f, {
      studentSeats: 100,
      months: 13,
      startsOn: start,
      paymentPlan: "yearly",
    });
    expect(made).toMatchObject({
      months: 13,
      startsOn: start,
      paymentPlan: "yearly",
      paymentProposal: null,
      status: "open",
    });
  });

  integrationTest("a custom proposal's shares add up and its dates fall in the term", async () => {
    const f = await school();
    const start = plusDays(5);
    const base = { studentSeats: 50, months: 6, startsOn: start, paymentPlan: "custom" as const };
    expect(
      await refusal(
        request(f, { ...base, paymentProposal: [{ dueDate: start, shareBps: 9_000 }] }),
      ),
    ).toBe("LICENSE_PAYMENT_SCHEDULE_INVALID");
    // After the 6-month term ends.
    expect(
      await refusal(
        request(f, { ...base, paymentProposal: [{ dueDate: plusDays(250), shareBps: 10_000 }] }),
      ),
    ).toBe("LICENSE_PAYMENT_SCHEDULE_INVALID");
    // Without a length there is no term to fall in.
    expect(
      await refusal(
        request(f, {
          ...base,
          months: null,
          paymentProposal: [{ dueDate: start, shareBps: 10_000 }],
        }),
      ),
    ).toBe("LICENSE_PAYMENT_SCHEDULE_INVALID");
    // A proposal for any plan but custom.
    expect(
      await refusal(
        request(f, {
          ...base,
          paymentPlan: "monthly",
          paymentProposal: [{ dueDate: start, shareBps: 10_000 }],
        }),
      ),
    ).toBe("LICENSE_PAYMENT_SCHEDULE_INVALID");

    const made = await request(f, {
      ...base,
      paymentProposal: [
        { dueDate: start, shareBps: 3_000 },
        { dueDate: plusDays(95), shareBps: 7_000 },
      ],
    });
    expect(made.paymentProposal).toHaveLength(2);
  });

  integrationTest("a start date in the past is refused", async () => {
    const f = await school();
    expect(await refusal(request(f, { studentSeats: 10, months: 6, startsOn: "2020-01-01" }))).toBe(
      "VALIDATION_FAILED",
    );
  });
});

describe("the super admin's quote answers the request", () => {
  integrationTest(
    "the school's choice needs no reason, and accepting resolves the request",
    async () => {
      const f = await school();
      const start = plusDays(10);
      const req = await request(f, {
        studentSeats: 10,
        months: 13,
        startsOn: start,
        paymentPlan: "yearly",
      });
      const quote = await quoteFor(f, {
        ...newTerm(10, { months: 13, startsAt: new Date(`${start}T00:00:00Z`) }),
        changeRequestId: req.id,
      });
      // The school's plan is the default.
      expect(quote.paymentPlan).toBe("yearly");
      expect(quote.termsChanges).toEqual([]);
      expect(quote.termsChangeReason).toBeNull();
      expect(quote.requestedTerms).toMatchObject({
        months: 13,
        startsOn: start,
        paymentPlan: "yearly",
      });
      // 13 months: year 1 pays for 12 of them, year 2 for 1.
      expect(quote.schedulePreview).toHaveLength(2);
      expect(quote.yearTotals.map((y) => [y.year, y.months, y.payments])).toEqual([
        [1, 12, 1],
        [2, 1, 1],
      ]);
      expect(quote.yearTotals.reduce((sum, y) => sum + y.amountMinor, 0)).toBe(quote.totalMinor);
      const sent = await as(f.schoolId, operator, async (tx) => ({
        result: await sendQuote(tx, f.schoolId, quote.id, operator),
      }));
      const { invoice } = await accepted(f, sent.id);
      expect(invoice.paymentPlan).toBe("yearly");
      const view = await detail(f, invoice.id);
      expect(view.instalments.map((i) => i.dueDate)).toEqual([
        start,
        ISO(
          new Date(
            Date.UTC(
              Number(start.slice(0, 4)) + 1,
              Number(start.slice(5, 7)) - 1,
              Number(start.slice(8, 10)),
            ),
          ),
        ),
      ]);
      expect(view.yearTotals.map((y) => y.amountMinor)).toEqual(
        quote.yearTotals.map((y) => y.amountMinor),
      );
      expect(view.instalments[0]!.aiStopDate).toBe(
        ISO(new Date(Date.parse(`${start}T00:00:00Z`) + 30 * DAY)),
      );
      const status = await asAdmin(
        f.schoolId,
        async (tx) =>
          tx<{ status: string }[]>`
        SELECT status FROM app.license_change_requests WHERE id = ${req.id}::uuid
      `,
      );
      expect(status[0]!.status).toBe("resolved");
    },
  );

  integrationTest("changing the school's choice needs a reason the school can read", async () => {
    const f = await school();
    const req = await request(f, { studentSeats: 10, months: 12, paymentPlan: "monthly" });
    const terms = { ...newTerm(10, { months: 6 }), changeRequestId: req.id };
    expect(await refusal(quoteFor(f, terms))).toBe("LICENSE_TERMS_CHANGE_REASON_REQUIRED");
    const quote = await quoteFor(f, {
      ...terms,
      paymentPlan: "yearly",
      termsChangeReason: "  Six months is the most we can offer this term  ",
    });
    expect(quote.termsChanges).toEqual(["months", "plan"]);
    expect(quote.termsChangeReason).toBe("Six months is the most we can offer this term");

    // Back to the school's choice: the reason is dropped.
    const back = await as(f.schoolId, operator, async (tx) => ({
      result: await replaceQuote(
        tx,
        f.schoolId,
        quote.id,
        { ...newTerm(10, { months: 12 }), paymentPlan: "monthly" },
        operator,
      ),
    }));
    expect(back.termsChanges).toEqual([]);
    expect(back.termsChangeReason).toBeNull();
  });

  integrationTest("a custom proposal becomes amounts from the school's shares", async () => {
    const f = await school();
    const start = plusDays(3);
    const later = plusDays(120);
    const req = await request(f, {
      studentSeats: 10,
      months: 8,
      startsOn: start,
      paymentPlan: "custom",
      paymentProposal: [
        { dueDate: start, shareBps: 2_500 },
        { dueDate: later, shareBps: 7_500 },
      ],
    });
    const terms = {
      ...newTerm(10, { months: 8, startsAt: new Date(`${start}T00:00:00Z`) }),
      changeRequestId: req.id,
    };
    // 10 x 30.00 x 8 = 2400.00: a quarter and three quarters.
    const quote = await quoteFor(f, {
      ...terms,
      paymentPlan: "custom",
      paymentSchedule: [
        { amountMinor: 60_000, dueDate: start },
        { amountMinor: 180_000, dueDate: later },
      ],
    });
    expect(quote.termsChanges).toEqual([]);
    // Different amounts are a change to the schedule.
    expect(
      await refusal(
        quoteFor(f, {
          ...terms,
          paymentPlan: "custom",
          paymentSchedule: [
            { amountMinor: 120_000, dueDate: start },
            { amountMinor: 120_000, dueDate: later },
          ],
        }),
      ),
    ).toBe("LICENSE_TERMS_CHANGE_REASON_REQUIRED");
  });

  integrationTest("only an open request of the school can be answered", async () => {
    const f = await school();
    const other = await school(0, "Other School");
    const req = await request(other, { studentSeats: 10, months: 12, paymentPlan: "monthly" });
    expect(await refusal(quoteFor(f, { ...newTerm(10), changeRequestId: req.id }))).toBe(
      "LICENSE_NOT_FOUND",
    );
  });
});

describe("the AI resumes when the late instalment is paid", () => {
  integrationTest("recording the transfer resumes a licence stopped for non-payment", async () => {
    const f = await school(1);
    const start = new Date(Date.now() - 60 * DAY);
    const quote = await quoteFor(f, {
      ...newTerm(1, { months: 12, startsAt: start }),
      paymentPlan: "monthly",
    });
    const { invoice } = await accepted(f, quote.id, operator);
    const [first, second] = (await detail(f, invoice.id)).instalments;
    // Paying the first instalment puts the licence in force.
    await pay(f, invoice.id, first!.amountMinor);
    const licenseId = invoice.licenseId;
    expect(await licenseStatus(f.schoolId, licenseId)).toBe("active");

    // The workers stop it once the second instalment is 30 days late; here, by hand.
    await asAdmin(f.schoolId, async (tx) => {
      await tx`
        UPDATE app.license_invoices SET issue_date = ${ISO(new Date(Date.now() - 40 * DAY))}::date
        WHERE id = ${invoice.id}::uuid
      `;
      await tx`
        UPDATE app.license_invoice_instalments SET due_date = ${ISO(new Date(Date.now() - 31 * DAY))}::date
        WHERE invoice_id = ${invoice.id}::uuid AND position = 2
      `;
      await tx`
        UPDATE app.license_invoice_instalments SET due_date = ${ISO(new Date(Date.now() - 32 * DAY))}::date
        WHERE invoice_id = ${invoice.id}::uuid AND position = 1
      `;
      await tx`
        UPDATE app.school_licenses SET status = 'suspended', nonpayment_suspended_at = now()
        WHERE id = ${licenseId}::uuid
      `;
    });
    const stopped = await inSchool(db.sql, f.schoolId, f.admin, async (tx) =>
      licenseView(tx, (await readLicense(tx, licenseId))!),
    );
    expect(stopped.nonpaymentSuspendedAt).not.toBeNull();
    expect(stopped.nextAiStop).toMatchObject({ invoiceId: invoice.id, position: 2 });
    expect(stopped.nextAiStop!.daysLeft).toBeLessThanOrEqual(0);

    // Part of it is not enough.
    const partial = await pay(f, invoice.id, 1);
    expect(partial.licenseResumed).toBe(false);
    expect(await licenseStatus(f.schoolId, licenseId)).toBe("suspended");

    const paid = await pay(f, invoice.id, second!.amountMinor - 1);
    expect(paid.licenseResumed).toBe(true);
    expect(await licenseStatus(f.schoolId, licenseId)).toBe("active");
    const after = await asAdmin(f.schoolId, async (tx) => (await readLicense(tx, licenseId))!);
    expect(after.nonpaymentSuspendedAt).toBeNull();
  });

  integrationTest("a licence the super admin suspended by hand stays suspended", async () => {
    const f = await school(1);
    const quote = await quoteFor(f, {
      ...newTerm(1, { months: 12, startsAt: new Date(Date.now() - DAY) }),
      paymentPlan: "monthly",
    });
    const { invoice } = await accepted(f, quote.id, operator);
    const [first] = (await detail(f, invoice.id)).instalments;
    await pay(f, invoice.id, first!.amountMinor);
    await as(
      f.schoolId,
      operator,
      (tx) => transitionLicense(tx, f.schoolId, invoice.licenseId, "suspended", operator) as never,
    );
    const paid = await pay(f, invoice.id, 100);
    expect(paid.licenseResumed).toBe(false);
    expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("suspended");
  });
});
