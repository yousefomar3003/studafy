// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { DOMAIN_EVENTS, ERPNEXT_DOC_EVENT_MAP } from "./events";

describe("ERPNEXT_DOC_EVENT_MAP", () => {
  test("all mapped values are valid DOMAIN_EVENTS", () => {
    const allEvents = Object.values(DOMAIN_EVENTS);
    for (const [, value] of Object.entries(ERPNEXT_DOC_EVENT_MAP)) {
      expect(value).toBeDefined();
      expect(allEvents).toContain(value!);
    }
  });

  test("maps Sales Invoice submitted to erpnext.invoiceSubmitted", () => {
    expect(ERPNEXT_DOC_EVENT_MAP["Sales Invoice-submitted"]).toBe(
      DOMAIN_EVENTS.ERPNEXT_INVOICE_SUBMITTED,
    );
  });

  test("maps Payment Entry submitted to erpnext.paymentReceived", () => {
    expect(ERPNEXT_DOC_EVENT_MAP["Payment Entry-submitted"]).toBe(
      DOMAIN_EVENTS.ERPNEXT_PAYMENT_RECEIVED,
    );
  });

  test("maps Fee Schedule submitted to erpnext.feeDue", () => {
    expect(ERPNEXT_DOC_EVENT_MAP["Fee Schedule-submitted"]).toBe(DOMAIN_EVENTS.ERPNEXT_FEE_DUE);
  });

  test("maps Sales Invoice return to erpnext.creditNoteIssued", () => {
    expect(ERPNEXT_DOC_EVENT_MAP["Sales Invoice-return"]).toBe(
      DOMAIN_EVENTS.ERPNEXT_CREDIT_NOTE_ISSUED,
    );
  });

  test("unknown doc-event pairs return undefined", () => {
    expect(ERPNEXT_DOC_EVENT_MAP["Student-submitted"]).toBeUndefined();
    expect(ERPNEXT_DOC_EVENT_MAP["Sales Invoice-cancelled"]).toBeUndefined();
  });
});
