// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { DOMAIN_EVENTS, ERPNEXT_DOC_EVENT_MAP } from "./events";

describe("DOMAIN_EVENTS", () => {
  // app.outbox_events.event_name carries exactly this CHECK (000022). A name that violates it is
  // accepted by TypeScript, published by nothing, and fails only at INSERT time in production —
  // inside whatever transaction was trying to emit it. ST-139's ticket specified a three-segment
  // `notification.dispatch.failed`, which is what this test exists to have caught.
  test("every event name matches the outbox event_name CHECK", () => {
    const outboxNamePattern = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;

    for (const value of Object.values(DOMAIN_EVENTS)) {
      expect(value).toMatch(outboxNamePattern);
    }
  });

  test("every event name is unique", () => {
    const values = Object.values(DOMAIN_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });
});

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
