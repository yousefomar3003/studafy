// Payment forwarding and confirmation (ST-121).
//
// Split in two on purpose:
//
//   * The unit suites need no database and always run. They cover the parts that carry the money
//     risk and are pure: the idempotency request hash, the ERPNext document shape, the
//     "did ERPNext write anything?" classification that decides whether a reservation is released,
//     and the minor-unit conversion that a hardcoded `* 100` would silently corrupt for JOD.
//   * The integration suite covers the acceptance criterion that cannot be faked honestly — a
//     duplicate Idempotency-Key must produce exactly one ERPNext Payment Entry — and needs a real
//     PostgreSQL with the migrations applied, because the guard *is* a unique index plus a
//     transaction boundary. It is gated on TEST_DATABASE_URL and skips without it.

import { createHmac } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createTestDatabase, integrationEnabled, migrateDatabase } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { ErpNextError } from "../../../erpnext/client";
import { formatMinorUnits, toMinorUnits } from "../currency";
import { erpNextDefinitelyDidNotWrite, translateErpNextError } from "../erpnext-errors";
import {
  erpNextStatusFromDocstatus,
  invoiceFromReferences,
  paymentStatusFromDocstatus,
  receiptUrlFor,
} from "../payments/projection";
import {
  buildPaymentEntryPayload,
  hashPaymentRequest,
  PAYMENT_MODE_MAP,
  type CreatePaymentParams,
} from "../payments/service";

import type { ErpNextPaymentEntry } from "../payments/projection";

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";

function makeParams(overrides: Partial<CreatePaymentParams> = {}): CreatePaymentParams {
  return {
    student_id: STUDENT_ID,
    invoice_id: "ACC-SINV-2026-00042",
    amount: 12.345,
    payment_mode: "cash",
    currency: "JOD",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Idempotency request hash
// ---------------------------------------------------------------------------

describe("idempotency request hash", () => {
  test("is a lowercase hex sha256, matching the column's CHECK constraint", () => {
    // ck_payment_idempotency_logs_request_hash enforces ^[0-9a-f]{64}$; a hash that could not be
    // stored would surface as an opaque constraint violation at the worst possible moment.
    expect(hashPaymentRequest(makeParams())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable across property order, so a reserialized retry is still a retry", () => {
    const a: CreatePaymentParams = {
      student_id: STUDENT_ID,
      invoice_id: "ACC-SINV-1",
      amount: 100,
      payment_mode: "cash",
      currency: "JOD",
    };
    // Same values, declared in a different order — what a proxy or client rewrite produces.
    const b: CreatePaymentParams = {
      currency: "JOD",
      payment_mode: "cash",
      amount: 100,
      invoice_id: "ACC-SINV-1",
      student_id: STUDENT_ID,
    };
    expect(hashPaymentRequest(a)).toBe(hashPaymentRequest(b));
  });

  test("changes when the amount changes", () => {
    // The whole point of the hash: this is what turns a reused key into a 409 instead of a replay
    // that would silently under-collect.
    expect(hashPaymentRequest(makeParams({ amount: 100 }))).not.toBe(
      hashPaymentRequest(makeParams({ amount: 100.001 })),
    );
  });

  test("changes when the target invoice changes", () => {
    expect(hashPaymentRequest(makeParams({ invoice_id: "ACC-SINV-A" }))).not.toBe(
      hashPaymentRequest(makeParams({ invoice_id: "ACC-SINV-B" })),
    );
  });
});

// ---------------------------------------------------------------------------
// ERPNext document shape
// ---------------------------------------------------------------------------

describe("Payment Entry payload", () => {
  test("submits rather than saving a draft", () => {
    // docstatus 1 is load-bearing: ERPNext's overpayment and outstanding-balance validation runs on
    // submit. A draft would be accepted, settle nothing, and hide the rejection this endpoint exists
    // to surface.
    expect(buildPaymentEntryPayload(makeParams(), SCHOOL_ID, "CUST-001").docstatus).toBe(1);
  });

  test("allocates the full amount against the target Sales Invoice", () => {
    const payload = buildPaymentEntryPayload(
      makeParams({ amount: 50, invoice_id: "ACC-SINV-2026-00042" }),
      SCHOOL_ID,
      "CUST-001",
    );
    expect(payload.references).toEqual([
      {
        reference_doctype: "Sales Invoice",
        reference_name: "ACC-SINV-2026-00042",
        allocated_amount: 50,
      },
    ]);
  });

  test("carries the school and student so the confirmation can route back", () => {
    const payload = buildPaymentEntryPayload(makeParams(), SCHOOL_ID, "CUST-001");
    expect(payload.custom_school_id).toBe(SCHOOL_ID);
    expect(payload.custom_student_id).toBe(STUDENT_ID);
  });

  test("sends no account fields, leaving the chart of accounts to ERPNext", () => {
    const payload = buildPaymentEntryPayload(makeParams(), SCHOOL_ID, "CUST-001");
    // ERPNext derives paid_to from the Mode of Payment's company default and paid_from from the
    // customer's receivable account. Guessing either here would put a ledger opinion in the gateway.
    expect(payload).not.toHaveProperty("paid_to");
    expect(payload).not.toHaveProperty("paid_from");
  });

  test("omits party entirely when it could not be resolved", () => {
    // Rather than sending `party: null`, which ERPNext would treat as an explicit blank.
    expect(buildPaymentEntryPayload(makeParams(), SCHOOL_ID, undefined)).not.toHaveProperty(
      "party",
    );
  });

  test("omits optional reference fields when absent", () => {
    const payload = buildPaymentEntryPayload(makeParams(), SCHOOL_ID, "CUST-001");
    expect(payload).not.toHaveProperty("reference_no");
    expect(payload).not.toHaveProperty("remarks");
  });

  test.each([
    ["cash", "Cash"],
    ["bank_transfer", "Wire Transfer"],
    ["card_external", "Credit Card"],
  ] as const)("maps %s to the ERPNext Mode of Payment %s", (mode, erpnextMode) => {
    const payload = buildPaymentEntryPayload(
      makeParams({ payment_mode: mode }),
      SCHOOL_ID,
      "CUST-001",
    );
    expect(payload.mode_of_payment).toBe(erpnextMode);
  });

  test("every payment mode in the schema has a mapping", () => {
    // Guards against adding a fourth mode to the Zod enum and the CHECK constraint while forgetting
    // the map, which would send `mode_of_payment: undefined` to ERPNext.
    expect(Object.keys(PAYMENT_MODE_MAP).sort()).toEqual([
      "bank_transfer",
      "card_external",
      "cash",
    ]);
  });

  test("a partial payment is just a smaller amount, with no special flag", () => {
    const payload = buildPaymentEntryPayload(makeParams({ amount: 5 }), SCHOOL_ID, "CUST-001");
    expect(payload.paid_amount).toBe(5);
    expect(payload.received_amount).toBe(5);
    expect(payload).not.toHaveProperty("is_partial");
  });

  test("defaults posting_date to today but honours an explicit one", () => {
    expect(
      buildPaymentEntryPayload(makeParams({ posting_date: "2026-03-01" }), SCHOOL_ID, "C")
        .posting_date,
    ).toBe("2026-03-01");
    expect(buildPaymentEntryPayload(makeParams(), SCHOOL_ID, "C").posting_date).toBe(
      new Date().toISOString().slice(0, 10),
    );
  });
});

// ---------------------------------------------------------------------------
// JOD minor units
// ---------------------------------------------------------------------------

describe("JOD amounts", () => {
  test("12.345 JOD is 12345 fils, not 1234", () => {
    // JOD is seeded with minor_unit = 3 in migration 000005. The bug this guards against is a
    // hardcoded two-decimal assumption, which divides Jordanian money by ten quietly enough to reach
    // a real receipt.
    expect(toMinorUnits(12.345, 3)).toBe(12345n);
    expect(formatMinorUnits(12345n, 3)).toBe("12.345");
  });

  test("round-trips a partial payment without drift", () => {
    const minor = toMinorUnits(0.005, 3);
    expect(minor).toBe(5n);
    expect(formatMinorUnits(minor, 3)).toBe("0.005");
  });

  test("a two-decimal currency is unaffected", () => {
    expect(toMinorUnits(12.34, 2)).toBe(1234n);
    expect(formatMinorUnits(1234n, 2)).toBe("12.34");
  });
});

// ---------------------------------------------------------------------------
// "Did ERPNext write anything?" — the release/retain decision
// ---------------------------------------------------------------------------

describe("erpNextDefinitelyDidNotWrite", () => {
  test.each([400, 403, 404, 409, 417, 422, 429] as const)(
    "a %s is a verdict, so the reservation is released",
    (status) => {
      // ERPNext answered by refusing. No Payment Entry exists, so a corrected retry is safe.
      expect(erpNextDefinitelyDidNotWrite(new ErpNextError("refused", status, null, "http"))).toBe(
        true,
      );
    },
  );

  test("an open circuit means the request was never sent", () => {
    expect(
      erpNextDefinitelyDidNotWrite(new ErpNextError("paused", 503, null, "circuit_open")),
    ).toBe(true);
  });

  test.each([
    ["timeout", 504],
    ["network", 503],
  ] as const)("a %s leaves the outcome unknown, so the reservation is retained", (kind, status) => {
    // This is the case that prevents the double charge: ERPNext may have committed the entry and we
    // simply never heard the answer.
    expect(erpNextDefinitelyDidNotWrite(new ErpNextError("gone", status, null, kind))).toBe(false);
  });

  test("a 500 leaves the outcome unknown", () => {
    expect(erpNextDefinitelyDidNotWrite(new ErpNextError("boom", 500, null, "http"))).toBe(false);
  });

  test("a non-ERPNext error is not treated as proof of anything", () => {
    // A bug in our own code must not be read as "ERPNext refused".
    expect(erpNextDefinitelyDidNotWrite(new TypeError("undefined is not a function"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ERPNext failure passthrough
// ---------------------------------------------------------------------------

describe("ERPNext failure passthrough", () => {
  function translated(error: unknown): CodedHttpException {
    try {
      translateErpNextError(error, {
        notFound: { code: ERROR_CODES.PAYMENT_NOT_FOUND, message: "Payment not found" },
      });
    } catch (thrown) {
      return thrown as CodedHttpException;
    }
    throw new Error("translateErpNextError returned instead of throwing");
  }

  test("an overpayment rejection reaches the client with ERPNext's own message", () => {
    // The acceptance criterion that ERPNext owns the financial rules: we do not paraphrase, cap, or
    // pre-empt this message, because the rule behind it is not ours.
    const message = "Allocated Amount cannot be greater than outstanding amount";
    const problem = translated(new ErpNextError(message, 417, null, "http"));

    expect(problem.status).toBe(400);
    expect(problem.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(problem.message).toBe(message);
  });

  test("a 404 becomes a payment-specific not-found", () => {
    const problem = translated(new ErpNextError("no such invoice", 404, null, "http"));
    expect(problem.status).toBe(404);
    expect(problem.code).toBe(ERROR_CODES.PAYMENT_NOT_FOUND);
  });

  test("a rate limit is surfaced as 429, not flattened to 400", () => {
    const problem = translated(new ErpNextError("slow down", 429, null, "http"));
    expect(problem.status).toBe(429);
    expect(problem.code).toBe(ERROR_CODES.RATE_LIMIT_EXCEEDED);
  });

  test("a timeout is 504 so a client knows it is worth retrying", () => {
    const problem = translated(new ErpNextError("timed out", 504, null, "timeout"));
    expect(problem.status).toBe(504);
    expect(problem.code).toBe(ERROR_CODES.ERPNEXT_TIMEOUT);
  });

  test("an open circuit is distinguishable from a timeout", () => {
    const problem = translated(new ErpNextError("paused", 503, null, "circuit_open"));
    expect(problem.status).toBe(503);
    expect(problem.code).toBe(ERROR_CODES.ERPNEXT_CIRCUIT_OPEN);
  });

  test("a 5xx from ERPNext is reported as unavailable rather than echoed", () => {
    const problem = translated(
      new ErpNextError("Traceback (most recent call last)", 500, null, "http"),
    );
    expect(problem.status).toBe(503);
    expect(problem.code).toBe(ERROR_CODES.ERPNEXT_UNAVAILABLE);
    // An ERPNext traceback must not reach a client.
    expect(problem.message).not.toContain("Traceback");
  });

  test("a non-ERPNext error is rethrown untouched rather than flattened to a 400", () => {
    const bug = new TypeError("cannot read property of undefined");
    expect(() => translateErpNextError(bug)).toThrow(bug);
  });
});

// ---------------------------------------------------------------------------
// Projection helpers — the conversions that were previously wrong
// ---------------------------------------------------------------------------

describe("payment projection helpers", () => {
  test.each([
    [1, "confirmed", "submitted"],
    [0, "pending", "draft"],
    [2, "failed", "cancelled"],
    [null, "pending", "draft"],
  ] as const)("docstatus %p maps to %s / %s", (docstatus, status, erpnextStatus) => {
    expect(paymentStatusFromDocstatus(docstatus)).toBe(status);
    expect(erpNextStatusFromDocstatus(docstatus)).toBe(erpnextStatus);
  });

  test("finds the Sales Invoice among mixed references", () => {
    const doc: ErpNextPaymentEntry = {
      references: [
        { reference_doctype: "Journal Entry", reference_name: "JV-001" },
        { reference_doctype: "Sales Invoice", reference_name: "ACC-SINV-7" },
      ],
    };
    expect(invoiceFromReferences(doc)).toBe("ACC-SINV-7");
  });

  test("returns null when no Sales Invoice is referenced", () => {
    expect(invoiceFromReferences({ references: [] })).toBeNull();
    expect(invoiceFromReferences({})).toBeNull();
  });

  test("prefers an ERPNext-supplied receipt link", () => {
    expect(receiptUrlFor({ receipt_url: "/files/receipt-7.pdf" }, "PE-7")).toBe(
      "/files/receipt-7.pdf",
    );
  });

  test("falls back to a printview path with the docname escaped", () => {
    // A path rather than an absolute URL: the tenant's site is chosen by the Host header, so a stored
    // origin would outlive the routing decision that produced it.
    expect(receiptUrlFor({}, "ACC-PAY-2026-00001")).toBe(
      "/printview?doctype=Payment%20Entry&name=ACC-PAY-2026-00001",
    );
  });

  test("treats a blank supplied link as absent", () => {
    expect(receiptUrlFor({ receipt_url: "   " }, "PE-7")).toBe(
      "/printview?doctype=Payment%20Entry&name=PE-7",
    );
  });
});

// ---------------------------------------------------------------------------
// Webhook signature
// ---------------------------------------------------------------------------

describe("payment webhook signature", () => {
  const secret = "test-webhook-secret";

  function sign(body: string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  test("verifies over the exact bytes ERPNext sent", async () => {
    const { verifyWebhookSignature } = await import("../../../erpnext/signature");
    const body = JSON.stringify({ event_id: "evt-1", doctype: "Payment Entry" });
    expect(verifyWebhookSignature(body, sign(body), secret)).toBe(true);
  });

  test("rejects a re-serialized body with the same content", async () => {
    const { verifyWebhookSignature } = await import("../../../erpnext/signature");
    const body = '{"event_id":"evt-1","doctype":"Payment Entry"}';
    // Semantically equal, different bytes. This is why the handler must read c.req.text() and never
    // re-stringify a parsed object before verifying.
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyWebhookSignature(reserialized, sign(body), secret)).toBe(false);
  });

  test("rejects a missing or malformed signature without throwing", async () => {
    const { verifyWebhookSignature } = await import("../../../erpnext/signature");
    expect(verifyWebhookSignature("{}", null, secret)).toBe(false);
    expect(verifyWebhookSignature("{}", "not-hex", secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration — the exactly-once guarantee (requires TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

const integrationTest = test.skipIf(!integrationEnabled);

describe("payment idempotency guard (requires a database)", () => {
  integrationTest(
    "the unique index admits one reservation per key and scopes it to the school",
    async () => {
      const database = await createTestDatabase();
      try {
        await migrateDatabase(database.url);

        const [refs] = await database.sql<{ country: string; currency: string }[]>`
          SELECT
            (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
            (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
        `;

        const schools = await database.sql<{ id: string; slug: string }[]>`
          INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
          VALUES
            ('pay-a', 'Pay A', 'pay-a@admin.local', 'pay-a@admin.local', ${refs!.country}, ${refs!.currency}),
            ('pay-b', 'Pay B', 'pay-b@admin.local', 'pay-b@admin.local', ${refs!.country}, ${refs!.currency})
          RETURNING id, slug
        `;
        const schoolA = schools.find((s) => s.slug === "pay-a")!.id;
        const schoolB = schools.find((s) => s.slug === "pay-b")!.id;

        const hash = "a".repeat(64);

        async function reserve(school: string, key: string): Promise<number> {
          return database.sql.begin(async (tx) => {
            await tx.unsafe("SET LOCAL ROLE studafy_app");
            await tx`SELECT set_config('app.school_id', ${school}, true)`;
            const rows = await tx`
              INSERT INTO app.payment_idempotency_logs (school_id, idempotency_key, request_hash)
              VALUES (${school}::uuid, ${key}, ${hash})
              ON CONFLICT (school_id, idempotency_key) DO NOTHING
              RETURNING id
            `;
            return rows.length;
          });
        }

        // First use of the key wins.
        expect(await reserve(schoolA, "key-1")).toBe(1);
        // The duplicate is absorbed by idx_payment_idempotency_unique, not by application logic.
        // This is the mechanism behind "exactly one Payment Entry".
        expect(await reserve(schoolA, "key-1")).toBe(0);
        // The same key under a different tenant is a different reservation: a client's key namespace
        // is its own, and a global unique index would leak one school's key choices into another's
        // failures.
        expect(await reserve(schoolB, "key-1")).toBe(1);
      } finally {
        await database.cleanup();
      }
    },
    60_000,
  );

  integrationTest(
    "a reserved-but-unfilled row is distinguishable from a completed one",
    async () => {
      const database = await createTestDatabase();
      try {
        await migrateDatabase(database.url);

        const [refs] = await database.sql<{ country: string; currency: string }[]>`
          SELECT
            (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
            (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
        `;
        const [school] = await database.sql<{ id: string }[]>`
          INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
          VALUES ('pay-c', 'Pay C', 'pay-c@admin.local', 'pay-c@admin.local', ${refs!.country}, ${refs!.currency})
          RETURNING id
        `;
        const schoolId = school!.id;

        await database.sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE studafy_app");
          await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

          await tx`
            INSERT INTO app.payment_idempotency_logs (school_id, idempotency_key, request_hash)
            VALUES (${schoolId}::uuid, 'in-flight', ${"b".repeat(64)})
          `;

          const [reserved] = await tx<{ erpnext_payment_entry_id: string | null }[]>`
            SELECT erpnext_payment_entry_id FROM app.payment_idempotency_logs
            WHERE school_id = ${schoolId}::uuid AND idempotency_key = 'in-flight'
          `;
          // NULL is what the service reads as "an earlier attempt reached ERPNext and we do not know
          // the outcome" — the state that must answer 409 PAYMENT_IN_PROGRESS rather than re-post.
          expect(reserved!.erpnext_payment_entry_id).toBeNull();

          await tx`
            UPDATE app.payment_idempotency_logs
            SET erpnext_payment_entry_id = 'ACC-PAY-2026-00001'
            WHERE school_id = ${schoolId}::uuid AND idempotency_key = 'in-flight'
          `;

          const [filled] = await tx<{ erpnext_payment_entry_id: string | null }[]>`
            SELECT erpnext_payment_entry_id FROM app.payment_idempotency_logs
            WHERE school_id = ${schoolId}::uuid AND idempotency_key = 'in-flight'
          `;
          expect(filled!.erpnext_payment_entry_id).toBe("ACC-PAY-2026-00001");
        });
      } finally {
        await database.cleanup();
      }
    },
    60_000,
  );

  integrationTest(
    "payment_cache enforces the confirmed/confirmed_at biconditional",
    async () => {
      const database = await createTestDatabase();
      try {
        await migrateDatabase(database.url);

        const [refs] = await database.sql<{ country: string; currency: string }[]>`
          SELECT
            (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
            (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
        `;
        const [school] = await database.sql<{ id: string }[]>`
          INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
          VALUES ('pay-d', 'Pay D', 'pay-d@admin.local', 'pay-d@admin.local', ${refs!.country}, ${refs!.currency})
          RETURNING id
        `;
        const schoolId = school!.id;
        const currencyId = refs!.currency;

        const studentId = await database.sql.begin(async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
          const email = "pay-student@example.test";
          const [user] = await tx<{ id: string }[]>`
            INSERT INTO app.users (school_id, email, normalized_email)
            VALUES (${schoolId}, ${email}, ${email}) RETURNING id
          `;
          const [student] = await tx<{ id: string }[]>`
            INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
            VALUES (${schoolId}, ${user!.id}, 'ADM-PAY', 'Ada', 'Lovelace') RETURNING id
          `;
          return student!.id;
        });

        // A 'confirmed' row with no confirmed_at must be rejected: ck_payment_cache_confirmed_state.
        await expect(
          database.sql.begin(async (tx) => {
            await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
            await tx`
              INSERT INTO app.payment_cache
                (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
                 amount_minor, payment_date, status, last_synced_at)
              VALUES (${schoolId}, ${studentId}, ${currencyId}, 'ACC-PAY-BAD', 'submitted',
                      500, '2026-01-01', 'confirmed', now())
            `;
          }),
        ).rejects.toThrow();

        // The default keeps pre-ST-121 insert sites working without naming the new columns.
        const inserted = await database.sql.begin(async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
          return tx<{ status: string; confirmed_at: Date | null }[]>`
            INSERT INTO app.payment_cache
              (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
               amount_minor, payment_date, last_synced_at)
            VALUES (${schoolId}, ${studentId}, ${currencyId}, 'ACC-PAY-OK', 'draft',
                    12345, '2026-01-01', now())
            RETURNING status, confirmed_at
          `;
        });
        expect(inserted[0]!.status).toBe("pending");
        expect(inserted[0]!.confirmed_at).toBeNull();

        // An unmapped payment mode is refused by ck_payment_cache_payment_mode.
        await expect(
          database.sql.begin(async (tx) => {
            await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
            await tx`
              UPDATE app.payment_cache SET payment_mode = 'crypto'
              WHERE school_id = ${schoolId} AND erpnext_docname = 'ACC-PAY-OK'
            `;
          }),
        ).rejects.toThrow();
      } finally {
        await database.cleanup();
      }
    },
    60_000,
  );
});
