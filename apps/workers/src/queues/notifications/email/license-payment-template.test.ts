import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EMAIL_EVENT_NAMES, resolveEmail } from "./resolve";
import { renderLicensePaymentEmail } from "./templates";

import type { LicensePaymentEmailData, LicensePaymentEmailKind } from "./templates";

/**
 * The licence instalment billing emails (000231): overdue, the 7-day warning before the AI stops,
 * and the AI stopped -- in English and Arabic, with how to pay and the invoice link, and no student
 * data. Snapshots pin the full copy of each.
 */

const base: LicensePaymentEmailData = {
  kind: "instalment_overdue",
  locale: "en",
  schoolName: "Amman Academy",
  invoiceNumber: "LIC-2026-000042",
  instalmentPosition: 2,
  instalmentCount: 12,
  amount: "250.00 USD",
  dueDate: "2026-11-01",
  stopDate: "2026-12-01",
  licenseStartsOn: "2026-10-01",
  licenseEndsOn: "2027-10-01",
  paymentReference: "STF-AB12-CD34",
  paymentLink: "https://checkout.revolut.com/pay/abc",
  bankDetails: {
    bankName: "Arab Bank",
    accountName: "Studafy FZ-LLC",
    iban: "JO94CBJO0010000000000131000302",
    swift: "ARABJOAX",
    currencyCode: "USD",
  },
  invoiceUrl: "https://app.studafy.test/portal/license/invoices/i-1",
};

const KINDS: LicensePaymentEmailKind[] = ["instalment_overdue", "ai_stop_warning", "ai_stopped"];

describe("renderLicensePaymentEmail", () => {
  for (const locale of ["en", "ar"] as const) {
    for (const kind of KINDS) {
      test(`${locale} ${kind}`, () => {
        const email = renderLicensePaymentEmail({ ...base, kind, locale });
        expect(email).toMatchSnapshot();
        for (const body of [email.text, email.html]) {
          expect(body).toContain("LIC-2026-000042");
          expect(body).toContain("250.00 USD");
          expect(body).toContain("STF-AB12-CD34");
          expect(body).toContain("JO94CBJO0010000000000131000302");
          expect(body).toContain("https://checkout.revolut.com/pay/abc");
          expect(body).toContain(base.invoiceUrl);
        }
        if (locale === "ar") expect(email.html).toContain('dir="rtl"');
      });
    }
  }

  test("says the cutoff date, and that the AI comes back once paid", () => {
    expect(renderLicensePaymentEmail(base).text).toContain(
      "If it is still unpaid on 1 December 2026, Studafy AI stops",
    );
    expect(renderLicensePaymentEmail({ ...base, kind: "ai_stopped" }).text).toContain(
      "come back as soon as Studafy records the payment",
    );
  });

  test("without a payment link or bank details, still says how to pay", () => {
    const email = renderLicensePaymentEmail({ ...base, paymentLink: null, bankDetails: null });
    expect(email.text).not.toContain("Pay online");
    expect(email.text).toContain("Studafy will send you the bank details for the transfer.");
    expect(email.text).toContain("STF-AB12-CD34");
  });

  test("escapes what it prints in the HTML", () => {
    const email = renderLicensePaymentEmail({ ...base, schoolName: "<b>Hill</b> & Co" });
    expect(email.html).not.toContain("<b>Hill</b>");
    expect(email.html).toContain("&lt;b&gt;Hill&lt;/b&gt; &amp; Co");
  });
});

describe("licenseInvoice.paymentEmail", () => {
  test("is claimed by the email dispatcher and resolves to the right template and link", () => {
    expect(EMAIL_EVENT_NAMES).toContain(DOMAIN_EVENTS.LICENSE_PAYMENT_EMAIL);
    const { schoolName: _school, invoiceUrl: _url, ...rest } = base;
    const email = resolveEmail(
      {
        id: "1",
        school_id: "s-1",
        event_name: DOMAIN_EVENTS.LICENSE_PAYMENT_EMAIL,
        payload: {
          ...rest,
          kind: "ai_stop_warning",
          schoolId: "s-1",
          invoiceId: "inv-9",
          instalmentId: "inst-2",
          email: "admin@school.example",
        },
        created_at: new Date().toISOString(),
      },
      { frontendUrl: "https://app.studafy.test", schoolName: "Amman Academy" },
    );
    expect(email.template).toBe("license-ai-stop-warning");
    expect(email.recipient).toBe("admin@school.example");
    expect(email.content.subject).toBe(
      "Studafy AI stops on 1 December 2026 unless invoice LIC-2026-000042 is paid",
    );
    expect(email.content.text).toContain("https://app.studafy.test/portal/license/invoices/inv-9");
  });
});
