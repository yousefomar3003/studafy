// Refund receipts: the PDF for money handed back to a family, and which refunds have one.
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createSchool,
  createStudent,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";
import { initiateRefund } from "../refunds/service";

import { renderRefundReceiptPdf } from "./render";
import { loadRefundReceipt } from "./service";
import { refundReceiptUrlFor } from "./url";

const isPdf = (pdf: Uint8Array) => new TextDecoder().decode(pdf.subarray(0, 5)) === "%PDF-";

describe("renderRefundReceiptPdf", () => {
  const input = {
    schoolName: "Studafy Demo Academy",
    taxRegistrationNumber: null,
    receiptNumber: "ACC-JV-2026-00010",
    refundDate: "2026-11-28",
    admissionNumber: "SDA-2024-001",
    familyName: null,
    invoiceId: "ACC-SINV-2026-00001",
    paidOutAmount: "100.000",
    refundAmount: "100.000",
    currency: "JOD",
    payoutMode: "cash" as const,
    reason: "overpayment" as const,
    notes: null,
    generatedAt: new Date("2026-11-28T09:00:00Z"),
  };

  test("renders an English refund receipt with lines to sign", async () => {
    expect(
      isPdf(await renderRefundReceiptPdf({ ...input, locale: "en", studentName: "Adam Fares" })),
    ).toBe(true);
  });

  test("renders an Arabic one, with part of the refund credited to the invoice and notes", async () => {
    const pdf = await renderRefundReceiptPdf({
      ...input,
      locale: "ar",
      studentName: "آدم فارس",
      familyName: "عائلة باسل فارس",
      refundAmount: "700.000",
      notes: "انسحاب في منتصف الفصل",
      taxRegistrationNumber: "100234567800003",
    });
    expect(isPdf(pdf)).toBe(true);
  });
});

describe("refundReceiptUrlFor", () => {
  test("only a completed credit note that handed money back has a receipt", () => {
    const paid = { id: "r1", kind: "credit_note", status: "completed", settlement: "paid_out" };
    expect(refundReceiptUrlFor(paid)).toBe("/api/finance/refunds/r1/receipt");
    expect(refundReceiptUrlFor({ ...paid, settlement: "invoice" })).toBeNull();
    expect(refundReceiptUrlFor({ ...paid, settlement: "family_credit" })).toBeNull();
    expect(
      refundReceiptUrlFor({ ...paid, status: "pending_approval", settlement: "pending" }),
    ).toBeNull();
    expect(refundReceiptUrlFor({ ...paid, kind: "payment_reversal" })).toBeNull();
  });
});

const describeDb = integrationEnabled ? describe : describe.skip;
let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
}, 60_000);

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

describeDb("loadRefundReceipt", () => {
  /** A refund in the given settled state, at a school in Amman (UTC+3). */
  async function settledRefund(settled: {
    settlement: "invoice" | "paid_out" | "family_credit";
    payoutMode?: "cash" | "credit";
    paidOutMinor?: number;
    completedAt?: string;
  }) {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    const maker = await createUser(db.sql, school.id);
    const checker = await createUser(db.sql, school.id);
    const { row } = await initiateRefund(
      db.sql,
      { schoolId: school.id, userId: maker.id },
      {
        student_id: student.id,
        erpnext_invoice_id: "ACC-SINV-RR-1",
        amount: 700,
        currency: "JOD",
        reason_code: "withdrawal",
        reason_notes: "Left mid-term",
        payout_mode: settled.payoutMode ?? "cash",
      },
      crypto.randomUUID(),
    );
    await db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
      await tx`
        INSERT INTO app.school_settings (school_id, timezone) VALUES (${school.id}::uuid, 'Asia/Amman')
        ON CONFLICT (school_id) DO UPDATE SET timezone = EXCLUDED.timezone
      `;
      await tx`
        UPDATE app.refund_requests
        SET status = 'completed', checker_id = ${checker.id}::uuid, approved_at = now(),
            completed_at = ${settled.completedAt ?? "2026-11-27T22:30:00Z"}::timestamptz,
            erpnext_credit_note_id = 'ACC-JV-RR-1', settlement = ${settled.settlement},
            paid_out_minor = ${settled.paidOutMinor ?? 0}
        WHERE id = ${row.id}::uuid
      `;
    });
    return { schoolId: school.id, refundId: row.id };
  }

  async function load(schoolId: string, refundId: string) {
    return db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
      return loadRefundReceipt(tx, schoolId, refundId, "en");
    });
  }

  test("a refund handed back in cash: what went back, of how much, dated in the school's own day", async () => {
    const { schoolId, refundId } = await settledRefund({
      settlement: "paid_out",
      paidOutMinor: 100_000,
    });
    const receipt = await load(schoolId, refundId);
    expect(receipt).toMatchObject({
      receiptNumber: "ACC-JV-RR-1",
      // 22:30 UTC on the 27th is already the 28th in Amman.
      refundDate: "2026-11-28",
      paidOutAmount: "100.000",
      refundAmount: "700.000",
      currency: "JOD",
      payoutMode: "cash",
      reason: "withdrawal",
      notes: "Left mid-term",
      invoiceId: "ACC-SINV-RR-1",
    });
    expect(receipt.studentName).not.toBe("");
    expect(isPdf(await renderRefundReceiptPdf(receipt))).toBe(true);
  });

  test("a refund that handed nothing back has no receipt", async () => {
    for (const settled of [
      { settlement: "invoice" as const },
      { settlement: "family_credit" as const, payoutMode: "credit" as const },
    ]) {
      const { schoolId, refundId } = await settledRefund(settled);
      await expect(load(schoolId, refundId)).rejects.toMatchObject({ status: 409 });
    }
  });
});
