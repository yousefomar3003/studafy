/**
 * Licence invoice payment plans against a real database (migration 000221, docs/adr/0021): a quote
 * paid at once, monthly or on a custom schedule; instalments that add up to the total; payments
 * spread earliest first (partial and voided ones included); activation once the first instalment is
 * paid; early activation moving the instalment to pay now; and each instalment's own payment link.
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
import { requireInvoiceDetail, setInvoicePaymentLink } from "../../src/modules/licensing/invoices";
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

const ISO = (date: Date) => date.toISOString().slice(0, 10);

async function detail(f: SchoolFixture, invoiceId: string) {
  return inSchool(db.sql, f.schoolId, f.admin, (tx) =>
    requireInvoiceDetail(tx, invoiceId, f.admin),
  );
}

async function linkInstalment(
  f: SchoolFixture,
  invoiceId: string,
  link: string | null,
  instalmentId?: string,
) {
  return as(f.schoolId, operator, async (tx) => ({
    result: await setInvoicePaymentLink(tx, f.schoolId, invoiceId, link, operator, instalmentId),
  }));
}

describe("payment plans on the quote", () => {
  integrationTest("paid at once is one instalment, as before", async () => {
    const f = await school();
    const quote = await sentQuote(f, newTerm(10));
    expect(quote.paymentPlan).toBe("in_full");
    expect(quote.schedulePreview).toHaveLength(1);
    const { invoice } = await accepted(f, quote.id);
    expect(invoice.paymentPlan).toBe("in_full");
    const view = await detail(f, invoice.id);
    expect(view.instalments).toMatchObject([
      { position: 1, amountMinor: invoice.totalMinor, dueDate: invoice.dueDate, current: true },
    ]);
  });

  integrationTest("monthly over an 8-month licence is 8 instalments from the start", async () => {
    const f = await school();
    const start = new Date(Date.now() + 10 * DAY);
    const quote = await sentQuote(f, {
      ...newTerm(10, { months: 8, startsAt: start }),
      paymentPlan: "monthly",
    } as QuoteTerms);
    // 10 seats x 30.00 x 8 months = 2400.00, no discount: 8 x 300.00.
    expect(quote.totalMinor).toBe(240_000);
    expect(quote.schedulePreview.map((i) => i.amountMinor)).toEqual(Array(8).fill(30_000));
    expect(quote.schedulePreview[0]!.dueDate).toBe(ISO(start));

    const { invoice } = await accepted(f, quote.id);
    const view = await detail(f, invoice.id);
    expect(view.instalments).toHaveLength(8);
    expect(view.instalments.reduce((s, i) => s + i.amountMinor, 0)).toBe(invoice.totalMinor);
    expect(invoice.dueDate).toBe(ISO(start));
  });

  integrationTest("a custom schedule must add up and be in order", async () => {
    const f = await school();
    const today = ISO(new Date());
    const later = ISO(new Date(Date.now() + 90 * DAY));
    const terms = (schedule: { amountMinor: number; dueDate: string }[]) =>
      ({
        ...newTerm(10, { months: 8 }),
        paymentPlan: "custom",
        paymentSchedule: schedule,
      }) as QuoteTerms;

    expect(await refusal(sentQuote(f, terms([{ amountMinor: 100_000, dueDate: today }])))).toBe(
      "LICENSE_PAYMENT_SCHEDULE_INVALID",
    );
    expect(
      await refusal(
        sentQuote(
          f,
          terms([
            { amountMinor: 120_000, dueDate: later },
            { amountMinor: 120_000, dueDate: today },
          ]),
        ),
      ),
    ).toBe("LICENSE_PAYMENT_SCHEDULE_INVALID");
    expect(
      await refusal(sentQuote(f, terms([{ amountMinor: 240_000, dueDate: "2020-01-01" }]))),
    ).toBe("LICENSE_PAYMENT_SCHEDULE_INVALID");

    const quote = await sentQuote(
      f,
      terms([
        { amountMinor: 120_000, dueDate: today },
        { amountMinor: 120_000, dueDate: later },
      ]),
    );
    const { invoice } = await accepted(f, quote.id);
    expect(
      (await detail(f, invoice.id)).instalments.map((i) => [i.amountMinor, i.dueDate]),
    ).toEqual([
      [120_000, today],
      [120_000, later],
    ]);
  });
});

describe("paying in instalments", () => {
  async function monthly(f: SchoolFixture) {
    const quote = await sentQuote(f, {
      ...newTerm(10, { months: 8 }),
      paymentPlan: "monthly",
    } as QuoteTerms);
    return (await accepted(f, quote.id)).invoice;
  }

  integrationTest(
    "payments fill the earliest instalment first; the licence starts after the first",
    async () => {
      const f = await school();
      const invoice = await monthly(f);
      expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("awaiting_payment");

      const part = await pay(f, invoice.id, 20_000);
      expect(part.licenseActivated).toBe(false);
      let view = await detail(f, invoice.id);
      expect(view.instalments[0]).toMatchObject({
        status: "partially_paid",
        paidMinor: 20_000,
        current: true,
      });

      const rest = await pay(f, invoice.id, 15_000);
      expect(rest.licenseActivated).toBe(true);
      expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("active");
      view = await detail(f, invoice.id);
      expect(view.instalments.slice(0, 2).map((i) => [i.status, i.paidMinor])).toEqual([
        ["paid", 30_000],
        ["partially_paid", 5_000],
      ]);
      expect(view.instalments[1]!.current).toBe(true);
      // The invoice now falls due on the second instalment.
      expect(view.dueDate).toBe(view.instalments[1]!.dueDate);
      expect(view.status).toBe("partially_paid");
    },
  );

  integrationTest("voiding a payment re-applies the rest, and never suspends", async () => {
    const f = await school();
    const invoice = await monthly(f);
    const first = await pay(f, invoice.id, 30_000);
    await pay(f, invoice.id, 30_000);
    await as(f.schoolId, operator, async (tx) => ({
      result: await voidPayment(tx, f.schoolId, first.payment.id, "Bounced", operator),
    }));
    const view = await detail(f, invoice.id);
    expect(view.instalments.slice(0, 2).map((i) => i.status)).toEqual(["paid", "due"]);
    expect(view.paidMinor).toBe(30_000);
    expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("active");
  });

  integrationTest("activating early moves the instalment to pay now", async () => {
    const f = await school();
    const invoice = await monthly(f);
    const view = await detail(f, invoice.id);
    const second = view.instalments[1]!.dueDate;
    expect(
      await refusal(
        as(
          f.schoolId,
          operator,
          (tx) =>
            activateEarly(
              tx,
              f.schoolId,
              invoice.id,
              ISO(new Date(Date.parse(second) + DAY)),
              operator,
            ) as never,
        ),
      ),
    ).toBe("LICENSE_PAYMENT_SCHEDULE_INVALID");
    await as(
      f.schoolId,
      operator,
      (tx) => activateEarly(tx, f.schoolId, invoice.id, second, operator) as never,
    );
    const after = await detail(f, invoice.id);
    expect(after.instalments[0]!.dueDate).toBe(second);
    expect(after.dueDate).toBe(second);
    expect(await licenseStatus(f.schoolId, invoice.licenseId)).toBe("active");
  });

  integrationTest(
    "each instalment has its own payment link; the school sees the current one's",
    async () => {
      const f = await school();
      const invoice = await monthly(f);
      const view = await detail(f, invoice.id);
      const [one, two] = view.instalments;

      await linkInstalment(f, invoice.id, "https://checkout.revolut.com/pay/one", one!.id);
      await linkInstalment(f, invoice.id, "https://checkout.revolut.com/pay/two", two!.id);
      expect(
        await refusal(linkInstalment(f, invoice.id, "https://evil.example/pay", two!.id)),
      ).toBe("LICENSE_PAYMENT_LINK_INVALID");
      expect(await refusal(linkInstalment(f, invoice.id, null, crypto.randomUUID()))).toBe(
        "LICENSE_INSTALMENT_NOT_FOUND",
      );

      let seen = await detail(f, invoice.id);
      expect(seen.paymentLink).toBe("https://checkout.revolut.com/pay/one");
      expect(seen.instalments.slice(0, 2).map((i) => i.paymentLink)).toEqual([
        "https://checkout.revolut.com/pay/one",
        "https://checkout.revolut.com/pay/two",
      ]);

      await pay(f, invoice.id, 30_000);
      seen = await detail(f, invoice.id);
      // A paid instalment's link is no longer shown; the invoice's is the next one's.
      expect(seen.instalments[0]!.paymentLink).toBeNull();
      expect(seen.paymentLink).toBe("https://checkout.revolut.com/pay/two");
      expect(await refusal(linkInstalment(f, invoice.id, null, one!.id))).toBe(
        "LICENSE_INVOICE_NOT_PAYABLE",
      );

      // The invoice-level route (000220) sets the link of the instalment to pay now.
      await linkInstalment(f, invoice.id, "https://revolut.me/studafy");
      expect((await detail(f, invoice.id)).instalments[1]!.paymentLink).toBe(
        "https://revolut.me/studafy",
      );
    },
  );

  integrationTest("the app role cannot change an instalment", async () => {
    const f = await school();
    const invoice = await monthly(f);
    const failure = await refusal(
      asApp(
        f.schoolId,
        (tx) =>
          tx`UPDATE app.license_invoice_instalments SET payment_link = NULL WHERE invoice_id = ${invoice.id}::uuid`,
      ),
    );
    expect(failure).toBe("42501"); // insufficient_privilege
  });
});
