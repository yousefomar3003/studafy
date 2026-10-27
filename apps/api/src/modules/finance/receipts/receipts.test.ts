// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { renderReceiptPdf } from "./render";

describe("renderReceiptPdf", () => {
  const input = {
    schoolName: "Studafy Demo Academy",
    receiptNumber: "ACC-PAY-2026-00004",
    paymentDate: "2026-10-26",
    status: "confirmed" as const,
    admissionNumber: "SDA-2024-001",
    invoiceId: "ACC-SINV-2026-00007",
    amount: "300.000",
    currency: "JOD",
    paymentMode: "cash" as const,
    generatedAt: new Date("2026-10-26T12:00:00Z"),
    familyName: null,
  };

  test("renders an English receipt", async () => {
    const pdf = await renderReceiptPdf({ ...input, locale: "en", studentName: "Adam Fares" });
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
  });

  test("renders an Arabic receipt with Arabic and Latin text mixed", async () => {
    const pdf = await renderReceiptPdf({
      ...input,
      locale: "ar",
      studentName: "آدم فارس",
      familyName: "عائلة باسل فارس",
    });
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
  });
});
