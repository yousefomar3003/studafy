/**
 * License pricing, quotes, invoices and bank-transfer payments against a real database (migration
 * 000165, session 3 of docs/billing/feature-licensing.md).
 *
 * The flows end to end: a quote accepted, invoiced, paid in two parts and activated; early
 * activation with a due date; a voided payment and the balance after it; receipts matched to
 * payments; a prorated seat increase; overlap credits as invoice lines, claimed once; quotes that
 * expire or go stale; tenant isolation of the new tables; and the routes' permissions.
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  acceptQuote,
  activateEarly,
  assignSeats,
  createLicense,
  createQuote,
  createReceipt,
  matchReceipt,
  readInvoice,
  recordPayment,
  replacePriceSettings,
  runLicenseChange,
  sendQuote,
  transitionLicense,
  updateLicense,
  voidInvoice,
  voidPayment,
  withdrawQuote,
  writeBankDetails,
} from "../../src/modules/licensing";
import { inSchool } from "../../src/modules/licensing/context";
import { readLicense } from "../../src/modules/licensing/service";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { LicenseActor, LicensingDeps, QuoteTerms } from "../../src/modules/licensing";
import type { TestApp, TestDatabase } from "../harness";
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

async function asApp<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
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

/** An active license made directly, for the change quotes. */
async function activeLicense(
  f: SchoolFixture,
  students: number,
  startsAt: Date,
  endsAt: Date,
): Promise<string> {
  return as(f.schoolId, operator, async (tx) => {
    const license = await createLicense(
      tx,
      f.schoolId,
      {
        startsAt,
        endsAt,
        currencyCode: "USD",
        includeFamilyPlus: false,
        student: { planId: tiers.student, seats: students },
      },
      operator,
    );
    const active = await transitionLicense(tx, f.schoolId, license.id, "active", operator);
    return { result: active.result.id, versions: active.versions };
  });
}

// ---------------------------------------------------------------------------------------------------
// Quote -> invoice -> payments -> active
// ---------------------------------------------------------------------------------------------------

describe("quote to active license", () => {
  integrationTest(
    "a quote is accepted, invoiced, paid in two parts, and the license activates",
    async () => {
      const f = await school();
      const quote = await sentQuote(f, newTerm(150));
      expect(quote).toMatchObject({
        status: "sent",
        totalMinor: 4_374_000,
        listTotalMinor: 5_400_000,
      });
      const line = quote.breakdown.lines[0]!;
      expect(line).toMatchObject({
        kind: "seats",
        listPricePerSeatMonthMinor: 3000,
        pricePerSeatMonthMinor: 2430,
        nextVolumeBracket: { minSeats: 500, seatsToAdd: 350, pricePerSeatMonthMinor: 2160 },
      });

      const { quote: done, invoice } = await accepted(f, quote.id);
      expect(done.status).toBe("accepted");
      expect(done.acceptedByPlatform).toBe(false);
      expect(invoice.number).toMatch(/^LIC-\d{4}-\d{6}$/);
      expect(invoice.paymentReference).toMatch(/^STF-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(invoice).toMatchObject({
        status: "issued",
        totalMinor: 4_374_000,
        paidMinor: 0,
        balanceMinor: 4_374_000,
        currencyCode: "USD",
      });
      // Due license.invoice_due_days (30) after issue.
      expect(Date.parse(invoice.dueDate) - Date.parse(invoice.issueDate)).toBe(30 * DAY);
      expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("awaiting_payment");

      const partial = await pay(f, invoice.id, 1_000_000);
      expect(partial.invoice).toMatchObject({
        status: "partially_paid",
        paidMinor: 1_000_000,
        balanceMinor: 3_374_000,
      });
      expect(partial.licenseActivated).toBe(false);
      expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("awaiting_payment");

      expect(await refusal(pay(f, invoice.id, 3_374_001))).toBe("LICENSE_PAYMENT_EXCEEDS_BALANCE");

      const full = await pay(f, invoice.id, 3_374_000);
      expect(full.invoice).toMatchObject({ status: "paid", paidMinor: 4_374_000, balanceMinor: 0 });
      expect(full.licenseActivated).toBe(true);
      expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("active");
      expect(await refusal(pay(f, invoice.id, 1))).toBe("LICENSE_INVOICE_NOT_PAYABLE");

      // Every change is audited: in the school (system actor) and in the operator's home school.
      const audited = await asAdmin(
        f.schoolId,
        (tx) => tx<{ target_table: string; action: string }[]>`
      SELECT target_table, action::text AS action FROM app.audit_logs
      WHERE school_id = ${f.schoolId}::uuid
        AND target_table IN ('license_quotes', 'license_invoices', 'license_payments', 'school_licenses')
    `,
      );
      expect(audited.filter((a) => a.target_table === "license_payments")).toHaveLength(2);
      expect(
        audited.some((a) => a.target_table === "license_invoices" && a.action === "insert"),
      ).toBe(true);
      const home = await asAdmin(
        hq,
        (tx) => tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.audit_logs
      WHERE school_id = ${hq}::uuid AND actor_id = ${operator.userId}::uuid
        AND target_table = 'license_payments'
    `,
      );
      expect(home[0]!.count).toBeGreaterThanOrEqual(2);
    },
  );

  integrationTest(
    "invoice numbers are sequential across schools; references are unique",
    async () => {
      const a = await school(0, "Numbering A");
      const b = await school(0, "Numbering B");
      const first = (await accepted(a, (await sentQuote(a, newTerm(10))).id)).invoice;
      const second = (await accepted(b, (await sentQuote(b, newTerm(10))).id)).invoice;
      const n = (number: string) => Number(number.split("-")[2]);
      expect(n(second.number)).toBe(n(first.number) + 1);
      expect(second.paymentReference).not.toBe(first.paymentReference);
    },
  );

  integrationTest(
    "the bank details and payment reference are on the school's invoice",
    async () => {
      const f = await school();
      const { invoice } = await accepted(f, (await sentQuote(f, newTerm(5))).id);
      const { requireInvoiceDetail } = await import("../../src/modules/licensing/invoices");
      const detail = await inSchool(db.sql, f.schoolId, f.admin, (tx) =>
        requireInvoiceDetail(tx, invoice.id, f.admin),
      );
      expect(detail.bankDetails).toEqual({
        bankName: "Arab Bank",
        accountName: "Studafy FZ-LLC",
        iban: "JO94CBJO0010000000000131000302",
        swift: "ARABJOAX",
        currencyCode: "USD",
      });
      expect(detail.paymentReference).toBe(invoice.paymentReference);
      expect(detail.lines).toHaveLength(1);
      // 5 x 30.00 x 12 less 10% (12 months).
      expect(detail.lines[0]).toMatchObject({ kind: "seats", seats: 5, amountMinor: 162_000 });
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Early activation, voids, receipts
// ---------------------------------------------------------------------------------------------------

describe("early activation", () => {
  integrationTest("the super admin activates before payment with a new due date", async () => {
    const f = await school();
    const { invoice } = await accepted(f, (await sentQuote(f, newTerm(20))).id);
    const dueDate = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);

    const result = (await as(
      f.schoolId,
      operator,
      (tx) => activateEarly(tx, f.schoolId, invoice.id, dueDate, operator) as never,
    )) as { invoice: { dueDate: string; status: string }; licenseActivated: boolean };
    expect(result.licenseActivated).toBe(true);
    expect(result.invoice).toMatchObject({ dueDate, status: "issued" });
    expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("active");

    // Paying it later completes the invoice and leaves the license as it is.
    const paid = await pay(f, invoice.id, invoice.totalMinor);
    expect(paid.invoice.status).toBe("paid");
    expect(paid.licenseActivated).toBe(false);
  });

  integrationTest("a due date before the issue date is refused", async () => {
    const f = await school();
    const { invoice } = await accepted(f, (await sentQuote(f, newTerm(3))).id);
    expect(
      await refusal(
        as(
          f.schoolId,
          operator,
          (tx) => activateEarly(tx, f.schoolId, invoice.id, "2000-01-01", operator) as never,
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("voided payments", () => {
  integrationTest("voiding a payment recalculates the balance and never suspends", async () => {
    const f = await school();
    const { invoice } = await accepted(f, (await sentQuote(f, newTerm(10))).id);
    const total = invoice.totalMinor; // 10 x 30.00 x 12 less 10% = 3,240.00
    expect(total).toBe(324_000);

    const first = await pay(f, invoice.id, 124_000);
    const second = await pay(f, invoice.id, 200_000);
    expect(second.invoice.status).toBe("paid");
    expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("active");

    const voided = await as(f.schoolId, operator, async (tx) => ({
      result: await voidPayment(tx, f.schoolId, second.payment.id, "Bounced transfer", operator),
    }));
    expect(voided.payment).toMatchObject({ voidReason: "Bounced transfer" });
    expect(voided.invoice).toMatchObject({
      status: "partially_paid",
      paidMinor: 124_000,
      balanceMinor: 200_000,
    });
    // No automatic suspension.
    expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("active");

    expect(
      await refusal(
        as(f.schoolId, operator, async (tx) => ({
          result: await voidPayment(tx, f.schoolId, second.payment.id, "again", operator),
        })),
      ),
    ).toBe("LICENSE_PAYMENT_VOIDED");

    const none = await as(f.schoolId, operator, async (tx) => ({
      result: await voidPayment(tx, f.schoolId, first.payment.id, "Entered twice", operator),
    }));
    expect(none.invoice).toMatchObject({ status: "issued", paidMinor: 0, balanceMinor: total });

    // The payment rows are kept, voided.
    const rows = await asAdmin(
      f.schoolId,
      (tx) => tx<{ voided: boolean }[]>`
      SELECT voided_at IS NOT NULL AS voided FROM app.license_payments
      WHERE school_id = ${f.schoolId}::uuid AND invoice_id = ${invoice.id}::uuid
    `,
    );
    expect(rows.map((r) => r.voided)).toEqual([true, true]);
  });

  integrationTest("an invoice with payments cannot be voided; an unpaid one can", async () => {
    const f = await school();
    const { invoice } = await accepted(f, (await sentQuote(f, newTerm(4))).id);
    const payment = await pay(f, invoice.id, 1000);
    const voidIt = () =>
      as(f.schoolId, operator, async (tx) => ({
        result: await voidInvoice(tx, f.schoolId, invoice.id, "Wrong seats", operator),
      }));
    expect(await refusal(voidIt())).toBe("LICENSE_INVOICE_HAS_PAYMENTS");
    await as(f.schoolId, operator, async (tx) => ({
      result: await voidPayment(tx, f.schoolId, payment.payment.id, "Undo", operator),
    }));
    expect((await voidIt()).status).toBe("void");
    expect(await refusal(pay(f, invoice.id, 1))).toBe("LICENSE_INVOICE_NOT_PAYABLE");
  });

  integrationTest("the database refuses anything but a void on a payment", async () => {
    const f = await school();
    const { invoice } = await accepted(f, (await sentQuote(f, newTerm(4))).id);
    const { payment } = await pay(f, invoice.id, 1000);
    expect(
      await refusal(
        asAdmin(
          f.schoolId,
          (tx) => tx`
          UPDATE app.license_payments SET amount_minor = 999 WHERE id = ${payment.id}::uuid
        `,
        ).catch((err: { constraint_name?: string }) => {
          throw { code: err.constraint_name };
        }),
      ),
    ).toBe("ck_license_payments_void_only");
  });
});

describe("receipts", () => {
  integrationTest(
    "a school's receipt is matched to the payment, unmatched by its void, matched again",
    async () => {
      const f = await school();
      const { invoice } = await accepted(f, (await sentQuote(f, newTerm(10))).id);
      const file = {
        storageKey: `permanent/${f.schoolId}/${crypto.randomUUID()}/transfer.pdf`,
        fileName: "transfer.pdf",
        contentType: "application/pdf",
        sizeBytes: 48_213,
      };
      const receipt = await as(f.schoolId, f.admin, async (tx) => ({
        result: await createReceipt(
          tx,
          f.schoolId,
          invoice.id,
          file,
          "Paid from our main account",
          f.admin,
        ),
      }));
      expect(receipt).toMatchObject({
        status: "pending",
        paymentId: null,
        fileName: "transfer.pdf",
      });

      const first = await pay(f, invoice.id, 100_000, { receiptId: receipt.id });
      const matched = await asAdmin(
        f.schoolId,
        (tx) => tx<{ status: string; payment_id: string }[]>`
      SELECT status, payment_id::text AS payment_id FROM app.license_payment_receipts WHERE id = ${receipt.id}::uuid
    `,
      );
      expect(matched[0]).toEqual({ status: "matched", payment_id: first.payment.id });

      const second = await pay(f, invoice.id, 1000);
      const matchTo = (paymentId: string) =>
        as(f.schoolId, operator, async (tx) => ({
          result: await matchReceipt(tx, f.schoolId, receipt.id, paymentId, operator),
        }));
      expect(await refusal(matchTo(second.payment.id))).toBe("LICENSE_RECEIPT_ALREADY_MATCHED");

      await as(f.schoolId, operator, async (tx) => ({
        result: await voidPayment(tx, f.schoolId, first.payment.id, "Wrong amount", operator),
      }));
      const rematched = await matchTo(second.payment.id);
      expect(rematched).toMatchObject({ status: "matched", paymentId: second.payment.id });
    },
  );

  integrationTest("a receipt matches only a payment on its own invoice", async () => {
    const f = await school();
    const one = (await accepted(f, (await sentQuote(f, newTerm(2))).id)).invoice;
    // A second license term for the same school, as a draft quote accepted by the operator.
    const two = (await accepted(f, (await sentQuote(f, newTerm(3))).id, operator)).invoice;
    const receipt = await as(f.schoolId, f.admin, async (tx) => ({
      result: await createReceipt(
        tx,
        f.schoolId,
        one.id,
        {
          storageKey: `permanent/${f.schoolId}/x/r.png`,
          fileName: "r.png",
          contentType: "image/png",
          sizeBytes: 10,
        },
        null,
        f.admin,
      ),
    }));
    const other = await pay(f, two.id, 500);
    expect(
      await refusal(
        as(f.schoolId, operator, async (tx) => ({
          result: await matchReceipt(tx, f.schoolId, receipt.id, other.payment.id, operator),
        })),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------------------------------
// Seat increase, extension, overlap credits
// ---------------------------------------------------------------------------------------------------

describe("changes to a license in force", () => {
  // A one-year license, 2026-01-01 to 2027-01-01, priced on 2026-08-08: 146 days remain.
  const START = new Date("2026-01-01T00:00:00Z");
  const END = new Date("2027-01-01T00:00:00Z");
  const NOW = new Date("2026-08-08T00:00:00Z");

  integrationTest(
    "a seat increase is prorated for the rest of the term at the new total's bracket",
    async () => {
      const f = await school();
      const licenseId = await activeLicense(f, 150, START, END);

      const quote = await sentQuote(
        f,
        { kind: "seat_increase", licenseId, student: { planId: tiers.student, seats: 200 } },
        NOW,
      );
      const line = quote.breakdown.lines[0]!;
      expect(line).toMatchObject({
        kind: "seats",
        seats: 50,
        volumeSeats: 200,
        prorateDays: 146,
        // 30.00 x 50 x 146 x 12 / 365 = 7,200.00, less 10% volume, less 10% duration.
        listAmountMinor: 720_000,
        volumeDiscountBps: 1000,
        durationDiscountBps: 1000,
        amountMinor: 583_200,
        pricePerSeatMonthMinor: 2430,
      });
      expect(quote.totalMinor).toBe(583_200);

      const { invoice } = await accepted(f, quote.id, f.admin, NOW);
      expect(invoice.totalMinor).toBe(583_200);
      const license = await asAdmin(f.schoolId, (tx) => readLicense(tx, licenseId));
      expect(license!.studentSeats).toBe(200);
      expect(license!.status).toBe("active");
      const lines = await asAdmin(
        f.schoolId,
        (tx) => tx<{ prorate_days: number; seats: number }[]>`
      SELECT prorate_days, seats FROM app.license_invoice_lines WHERE invoice_id = ${invoice.id}::uuid
    `,
      );
      expect([...lines]).toEqual([{ prorate_days: 146, seats: 50 }]);
    },
  );

  integrationTest("fewer seats than the license has is not an increase", async () => {
    const f = await school();
    const licenseId = await activeLicense(f, 150, START, END);
    expect(
      await refusal(
        sentQuote(
          f,
          { kind: "seat_increase", licenseId, student: { planId: tiers.student, seats: 100 } },
          NOW,
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  integrationTest(
    "an extension charges the added months and moves the end date on acceptance",
    async () => {
      const f = await school();
      const licenseId = await activeLicense(f, 10, START, END);
      const quote = await sentQuote(f, { kind: "extension", licenseId, months: 12 }, NOW);
      // 10 x 30.00 x 12 less 10% (12 months).
      expect(quote.totalMinor).toBe(324_000);
      expect(quote.startsAt).toBe(END.toISOString());
      await accepted(f, quote.id, f.admin, NOW);
      const license = await asAdmin(f.schoolId, (tx) => readLicense(tx, licenseId));
      expect(license!.endsAt.toISOString()).toBe("2028-01-01T00:00:00.000Z");
    },
  );

  integrationTest(
    "overlap credits become invoice lines, claimed once, released by a void",
    async () => {
      const f = await school(2);
      const licenseId = await activeLicense(
        f,
        10,
        new Date(Date.now() - DAY),
        new Date(Date.now() + 300 * DAY),
      );
      await as(
        f.schoolId,
        f.admin,
        (tx) =>
          assignSeats(
            tx,
            f.schoolId,
            licenseId,
            { audience: "student", userIds: f.students.map((s) => s.userId) },
            f.admin,
          ) as never,
      );
      // Two credits as session 2 records them: one priced (44.38), one whose tier had no price then.
      const overlapIds = await asAdmin(f.schoolId, async (tx) => {
        const seats = await tx<{ id: string; user_id: string }[]>`
        SELECT id::text AS id, user_id::text AS user_id FROM app.license_seats
        WHERE license_id = ${licenseId}::uuid ORDER BY assigned_at, id
      `;
        const ids: string[] = [];
        for (const [i, seat] of seats.entries()) {
          const student = f.students.find((s) => s.userId === seat.user_id)!;
          const [sub] = await tx<{ id: string }[]>`
          INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
          VALUES (${f.schoolId}::uuid, ${student.id}::uuid, 'active', now() - interval '10 days', now() + interval '44 days')
          RETURNING id::text AS id
        `;
          const priced = i === 0;
          const [row] = await tx<{ id: string }[]>`
          INSERT INTO app.license_seat_overlaps (
            school_id, license_id, seat_id, user_id, ai_subscription_id, provider, overlap_starts_at,
            overlap_ends_at, overlap_days, currency_id, monthly_seat_price_minor,
            daily_seat_price_minor, credit_minor, renewal_action, renewal_status
          )
          SELECT ${f.schoolId}::uuid, ${licenseId}::uuid, ${seat.id}::uuid, ${seat.user_id}::uuid,
                 ${sub!.id}::uuid, 'tap', now(), now() + interval '44 days', 44, c.id,
                 ${priced ? 3000 : null}, ${priced ? 98.630137 : null}, ${priced ? 4438 : null},
                 'cancel_at_period_end', 'done'
          FROM app.currencies AS c WHERE c.code = 'USD'
          RETURNING id::text AS id
        `;
          ids.push(row!.id);
        }
        return ids;
      });

      const quote = await sentQuote(f, { kind: "extension", licenseId, months: 1 });
      const credits = quote.breakdown.lines.filter((l) => l.kind === "overlap_credit");
      // The unpriced one is priced now: 44 days x 30.00 x 12 / 365 = 43.40. (Both were recorded in one
      // transaction, so their order on the quote is by id, not by insertion.)
      expect(new Map(credits.map((c) => [c.reference, c.amountMinor]))).toEqual(
        new Map([
          [overlapIds[0]!, -4438],
          [overlapIds[1]!, -4340],
        ]),
      );
      // 10 seats x 30.00 x 1 month, less both credits.
      expect(quote.totalMinor).toBe(30_000 - 4438 - 4340);

      // A second quote priced before the first is accepted claims the same credits: it goes stale.
      const rival = await sentQuote(f, { kind: "extension", licenseId, months: 1 });
      const { invoice } = await accepted(f, quote.id);
      const lines = await asAdmin(
        f.schoolId,
        (tx) => tx<{ kind: string; amount_minor: string; overlap_id: string | null }[]>`
      SELECT kind, amount_minor::text AS amount_minor, overlap_id::text AS overlap_id
      FROM app.license_invoice_lines WHERE invoice_id = ${invoice.id}::uuid ORDER BY position
    `,
      );
      expect(lines[0]).toEqual({ kind: "seats", amount_minor: "30000", overlap_id: null });
      expect(new Map(lines.slice(1).map((l) => [l.overlap_id, [l.kind, l.amount_minor]]))).toEqual(
        new Map([
          [overlapIds[0]!, ["overlap_credit", "-4438"]],
          [overlapIds[1]!, ["overlap_credit", "-4340"]],
        ]),
      );
      expect(invoice).toMatchObject({
        subtotalMinor: 30_000,
        creditTotalMinor: 8778,
        totalMinor: 21_222,
      });
      expect(await refusal(accepted(f, rival.id))).toBe("LICENSE_QUOTE_STALE");

      // Claimed: the next quote has no credits. Voiding the invoice gives them back.
      const next = await sentQuote(f, { kind: "extension", licenseId, months: 1 });
      expect(next.creditTotalMinor).toBe(0);
      await as(f.schoolId, operator, async (tx) => ({
        result: await voidInvoice(tx, f.schoolId, invoice.id, "Re-issue", operator),
      }));
      const again = await sentQuote(f, { kind: "extension", licenseId, months: 1 });
      expect(again.creditTotalMinor).toBe(8778);
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Quote rules
// ---------------------------------------------------------------------------------------------------

describe("quote rules", () => {
  integrationTest("an expired quote cannot be accepted", async () => {
    const f = await school();
    const past = new Date(Date.now() - 40 * DAY);
    const quote = await sentQuote(f, newTerm(5, { startsAt: past }), past);
    expect(await refusal(accepted(f, quote.id))).toBe("LICENSE_QUOTE_EXPIRED");
  });

  integrationTest("a quote whose license changed after pricing is stale", async () => {
    const f = await school();
    const licenseId = await activeLicense(
      f,
      10,
      new Date(Date.now() - DAY),
      new Date(Date.now() + 200 * DAY),
    );
    const quote = await sentQuote(f, {
      kind: "seat_increase",
      licenseId,
      student: { planId: tiers.student, seats: 20 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await as(
      f.schoolId,
      operator,
      (tx) =>
        updateLicense(tx, f.schoolId, licenseId, { student: { seats: 12 } }, operator) as never,
    );
    expect(await refusal(accepted(f, quote.id))).toBe("LICENSE_QUOTE_STALE");
  });

  integrationTest("the school sees no drafts and cannot accept a withdrawn quote", async () => {
    const f = await school();
    const draft = await as(f.schoolId, operator, async (tx) => ({
      result: await createQuote(tx, f.schoolId, newTerm(5), operator),
    }));
    expect(await refusal(accepted(f, draft.id))).toBe("LICENSE_QUOTE_NOT_FOUND");
    const sent = await sentQuote(f, newTerm(5));
    await as(f.schoolId, operator, async (tx) => ({
      result: await withdrawQuote(tx, f.schoolId, sent.id, operator),
    }));
    expect(await refusal(accepted(f, sent.id))).toBe("LICENSE_QUOTE_NOT_FOUND");
    // The super admin can accept a draft on the school's behalf.
    const byOperator = await accepted(f, draft.id, operator);
    expect(byOperator.quote.acceptedByPlatform).toBe(true);
  });

  integrationTest("a tier with no price in the currency is refused", async () => {
    const f = await school();
    expect(await refusal(sentQuote(f, newTerm(5, { currencyCode: "JOD" })))).toBe(
      "LICENSE_PRICE_MISSING",
    );
  });

  integrationTest(
    "a credit-free, fully adjusted quote issues a paid invoice and activates",
    async () => {
      const f = await school();
      const quote = await sentQuote(
        f,
        newTerm(1, { months: 1, adjustment: { amountMinor: -3000, reason: "Pilot school" } }),
      );
      expect(quote.totalMinor).toBe(0);
      const { invoice } = await accepted(f, quote.id);
      expect(invoice.status).toBe("paid");
      expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("active");
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------------------------------

describe("tenant isolation", () => {
  integrationTest(
    "a school sees only its own quotes, invoices, lines, payments and receipts",
    async () => {
      const a = await school(0, "Isolation A");
      const b = await school(0, "Isolation B");
      const { invoice } = await accepted(a, (await sentQuote(a, newTerm(3))).id);
      await pay(a, invoice.id, 1000);
      await as(a.schoolId, a.admin, async (tx) => ({
        result: await createReceipt(
          tx,
          a.schoolId,
          invoice.id,
          {
            storageKey: `permanent/${a.schoolId}/x/r.pdf`,
            fileName: "r.pdf",
            contentType: "application/pdf",
            sizeBytes: 5,
          },
          null,
          a.admin,
        ),
      }));

      const tables = [
        "license_quotes",
        "license_invoices",
        "license_invoice_lines",
        "license_payments",
        "license_payment_receipts",
      ];
      for (const table of tables) {
        const own = await asApp(a.schoolId, (tx) =>
          tx.unsafe(`SELECT count(*)::int AS count FROM app.${table}`),
        );
        const other = await asApp(b.schoolId, (tx) =>
          tx.unsafe(
            `SELECT count(*)::int AS count FROM app.${table} WHERE school_id = '${a.schoolId}'`,
          ),
        );
        expect([table, (own[0] as unknown as { count: number }).count > 0]).toEqual([table, true]);
        expect([table, (other[0] as unknown as { count: number }).count]).toEqual([table, 0]);
      }

      // B cannot read A's invoice through the service either.
      expect(
        await refusal(
          inSchool(db.sql, b.schoolId, b.admin, (tx) =>
            readInvoice(tx, invoice.id).then((i) => {
              if (!i) throw { code: "not visible" };
            }),
          ),
        ),
      ).toBe("not visible");
    },
  );

  integrationTest("the app role cannot record payments or touch the price list", async () => {
    const f = await school();
    const denied = async (statement: string) => {
      try {
        await asApp(f.schoolId, (tx) => tx.unsafe(statement));
        return "allowed";
      } catch (err) {
        return (err as { code?: string }).code;
      }
    };
    // 42501: insufficient_privilege.
    expect(await denied("SELECT 1 FROM app.license_price_settings")).toBe("42501");
    expect(await denied("SELECT 1 FROM app.license_price_brackets")).toBe("42501");
    expect(await denied("SELECT 1 FROM app.license_invoice_counters")).toBe("42501");
    expect(await denied("UPDATE app.license_payments SET note = 'x'")).toBe("42501");
    expect(await denied("DELETE FROM app.license_invoices")).toBe("42501");
  });
});

// ---------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------

describe("route permissions", () => {
  let api: TestApp;

  beforeAll(async () => {
    if (!integrationEnabled) return;
    const created = createTestApp({ database: db.sql });
    await created.ready;
    api = created;
  });

  const json = (body: unknown) => ({
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

  async function asRole(
    f: SchoolFixture,
    role: (typeof ROLES)[keyof typeof ROLES],
    method: string,
    path: string,
    body?: unknown,
  ) {
    const user = await createUser(db.sql, f.schoolId);
    await assignRole(db.sql, f.schoolId, user.id, role);
    return authenticatedRequest(
      api,
      method,
      path,
      { schoolId: f.schoolId, userId: user.id, roles: [role], channel: AUTH_CHANNELS.WEB },
      body === undefined ? undefined : json(body),
    );
  }

  const asOperator = (
    method: string,
    path: string,
    body?: unknown,
    channel: (typeof AUTH_CHANNELS)[keyof typeof AUTH_CHANNELS] = AUTH_CHANNELS.WEB,
  ) =>
    authenticatedRequest(
      api,
      method,
      path,
      { schoolId: hq, userId: operator.userId, roles: [ROLES.SUPER_ADMIN], channel },
      body === undefined ? undefined : json(body),
    );

  integrationTest(
    "the school's billing: license:read to read, license:manage to accept",
    async () => {
      const f = await school();
      const quote = await sentQuote(f, newTerm(10));

      for (const role of [ROLES.ORG_ADMIN, ROLES.PRINCIPAL]) {
        for (const path of [
          "/api/school/license/quotes",
          `/api/school/license/quotes/${quote.id}`,
          "/api/school/license/invoices",
          "/api/school/license/payments",
        ]) {
          expect([role, path, (await asRole(f, role, "GET", path)).status]).toEqual([
            role,
            path,
            200,
          ]);
        }
      }
      for (const role of [ROLES.INSTRUCTOR, ROLES.STUDENT, ROLES.PARENT, ROLES.FINANCE]) {
        expect((await asRole(f, role, "GET", "/api/school/license/invoices")).status).toBe(403);
        expect(
          (await asRole(f, role, "POST", `/api/school/license/quotes/${quote.id}/accept`)).status,
        ).toBe(403);
      }

      const listed = (await (
        await asRole(f, ROLES.ORG_ADMIN, "GET", "/api/school/license/quotes")
      ).json()) as {
        quotes: { id: string; status: string }[];
      };
      expect(listed.quotes.map((q) => q.status)).toEqual(["sent"]);

      const accept = await asRole(
        f,
        ROLES.PRINCIPAL,
        "POST",
        `/api/school/license/quotes/${quote.id}/accept`,
      );
      expect(accept.status).toBe(200);
      const { invoice } = (await accept.json()) as {
        invoice: { id: string; paymentReference: string };
      };

      const detail = await asRole(
        f,
        ROLES.ORG_ADMIN,
        "GET",
        `/api/school/license/invoices/${invoice.id}`,
      );
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        paymentReference: invoice.paymentReference,
        bankDetails: { iban: "JO94CBJO0010000000000131000302" },
        overdue: false,
      });

      // No object storage in this app: the receipt route answers 503, not 500.
      const upload = await asRole(
        f,
        ROLES.ORG_ADMIN,
        "POST",
        `/api/school/license/invoices/${invoice.id}/receipts`,
        {
          storageKey: `temp/${f.schoolId}/x/receipt.pdf`,
        },
      );
      expect(upload.status).toBe(503);

      const unpaid = (await (
        await asRole(f, ROLES.ORG_ADMIN, "GET", "/api/school/license/invoices?status=unpaid")
      ).json()) as { invoices: unknown[]; status: string };
      expect(unpaid).toMatchObject({ status: "unpaid" });
      expect(unpaid.invoices).toHaveLength(1);
    },
  );

  integrationTest("the billing console is SUPER_ADMIN only, on the web", async () => {
    const f = await school();
    expect(
      (await asRole(f, ROLES.ORG_ADMIN, "GET", "/api/platform/licenses/price-settings")).status,
    ).toBe(403);
    expect((await asRole(f, ROLES.ORG_ADMIN, "GET", "/api/platform/licenses/finance")).status).toBe(
      403,
    );
    expect(
      (
        await asRole(
          f,
          ROLES.ORG_ADMIN,
          "POST",
          `/api/platform/schools/${f.schoolId}/license-quotes`,
          newTerm(1),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await asOperator(
          "GET",
          "/api/platform/licenses/price-settings",
          undefined,
          AUTH_CHANNELS.API,
        )
      ).status,
    ).toBe(403);

    const settings = (await (
      await asOperator("GET", "/api/platform/licenses/price-settings")
    ).json()) as {
      settings: { currencyCode: string; volumeBrackets: unknown[] }[];
    };
    expect(settings.settings.find((s) => s.currencyCode === "USD")?.volumeBrackets).toHaveLength(3);

    const invalid = await asOperator("PUT", "/api/platform/licenses/price-settings/USD", {
      volumeBasis: "overall",
      volumeBrackets: [
        { audience: null, minSeats: 100, discountBps: 1000 },
        { audience: null, minSeats: 100, discountBps: 2000 },
      ],
      durationDiscounts: [],
    });
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { code: string }).code).toBe("LICENSE_PRICING_INVALID");

    // The calculator prices without saving.
    const preview = await asOperator(
      "POST",
      "/api/platform/licenses/quote",
      newTerm(500, { months: 24 }),
    );
    expect(preview.status).toBe(200);
    expect(
      ((await preview.json()) as { breakdown: { totalMinor: number } }).breakdown.totalMinor,
    ).toBe(
      // 30.00 x 500 x 24 = 360,000.00, less 20%, less 15%.
      24_480_000,
    );

    // Quote -> send -> accept (school) -> payment, all through the routes.
    const created = await asOperator(
      "POST",
      `/api/platform/schools/${f.schoolId}/license-quotes`,
      newTerm(10),
    );
    expect(created.status).toBe(201);
    const quote = (await created.json()) as { id: string };
    expect(
      (
        await asOperator(
          "POST",
          `/api/platform/schools/${f.schoolId}/license-quotes/${quote.id}/send`,
        )
      ).status,
    ).toBe(200);
    const accept = await asRole(
      f,
      ROLES.ORG_ADMIN,
      "POST",
      `/api/school/license/quotes/${quote.id}/accept`,
    );
    const { invoice } = (await accept.json()) as { invoice: { id: string; totalMinor: number } };

    const paid = await asOperator(
      "POST",
      `/api/platform/schools/${f.schoolId}/license-invoices/${invoice.id}/payments`,
      {
        amountMinor: invoice.totalMinor,
        receivedAt: new Date().toISOString(),
        bankReference: "FT2611",
      },
    );
    expect(paid.status).toBe(201);
    expect(await paid.json()).toMatchObject({
      licenseActivated: true,
      invoice: { status: "paid" },
    });

    const unpaid = (await (
      await asOperator("GET", `/api/platform/licenses/invoices?schoolId=${f.schoolId}&status=paid`)
    ).json()) as { invoices: { id: string; schoolName: string }[] };
    expect(unpaid.invoices.map((i) => i.id)).toEqual([invoice.id]);

    const finance = await asOperator("GET", "/api/platform/licenses/finance");
    expect(finance.status).toBe(200);
    const totals = (await finance.json()) as {
      totals: { currencyCode: string; receivedThisMonthMinor: number }[];
    };
    expect(
      totals.totals.find((t) => t.currencyCode === "USD")!.receivedThisMonthMinor,
    ).toBeGreaterThanOrEqual(invoice.totalMinor);

    const bank = await asOperator("PUT", "/api/platform/licenses/bank-details", {
      bankName: "Arab Bank",
      accountName: "Studafy FZ-LLC",
      iban: "not-an-iban",
      swift: "ARABJOAX",
      currencyCode: "USD",
    });
    expect(bank.status).toBe(400);
  });
});
