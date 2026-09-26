import {
  deriveIntent,
  extractCustomerId,
  extractPeriod,
  extractSchoolIdHint,
} from "@studafy/billing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { normalizeTapCharge, TapChargeShapeError } from "../tap/event-normalizer";

import type { TapCharge } from "@studafy/tap-payments";

const SCHOOL_ID = "7b0c2f6e-3a51-4c1b-9a53-6f1f0b1d2e3a";

function charge(status: string, billingReason?: string): TapCharge {
  return {
    id: "chg_TS01",
    object: "charge",
    live_mode: false,
    status,
    amount: 15.5,
    currency: "JOD",
    customer: { id: "cus_TS01" },
    metadata: {
      school_id: SCHOOL_ID,
      ...(billingReason ? { billing_reason: billingReason } : {}),
    },
    transaction: { created: "1727251200000", url: "https://checkout.tap.company/x" },
  };
}

describe("normalizeTapCharge — the same internal events as Stripe", () => {
  // Each row: a Tap charge, and the Stripe event that means the same thing to Studafy. Parity is
  // asserted through the state machine's own classifier, not by comparing strings, so the test
  // fails if either side's meaning drifts.
  const parity: [string, TapCharge, string, Record<string, unknown>][] = [
    [
      "first checkout paid",
      charge("CAPTURED", "subscription_create"),
      "checkout.session.completed",
      {},
    ],
    ["renewal paid", charge("CAPTURED", "subscription_cycle"), "invoice.paid", {}],
    ["renewal declined", charge("DECLINED", "subscription_cycle"), "invoice.payment_failed", {}],
    [
      "first checkout declined",
      charge("DECLINED", "subscription_create"),
      "checkout.session.expired",
      {},
    ],
    ["charge pending", charge("INITIATED", "subscription_create"), "payment_intent.processing", {}],
    ["non-subscription charge paid", charge("CAPTURED"), "charge.succeeded", {}],
    ["non-subscription charge failed", charge("FAILED"), "charge.failed", {}],
  ];

  for (const [label, tap, stripeType, stripeData] of parity) {
    test(`${label}: ${tap.status} -> ${stripeType}`, () => {
      const event = normalizeTapCharge(tap);
      expect(event.type).toBe(stripeType);
      expect(deriveIntent(event.type, event.data)).toEqual(deriveIntent(stripeType, stripeData));
    });
  }

  test("a fee payment can never activate a subscription", () => {
    // Without the billing_reason gate a paid tuition fee would read as `activated`.
    const event = normalizeTapCharge(charge("CAPTURED"));
    expect(deriveIntent(event.type, event.data)).toEqual({ kind: "ignored" });
  });

  test("an unrecognised status is left unmapped so the pipeline parks it", () => {
    const event = normalizeTapCharge(charge("UNKNOWN", "subscription_create"));
    expect(event.type).toBe("tap.charge.unknown");
    expect(deriveIntent(event.type, event.data)).toEqual({ kind: "unmapped" });
  });
});

describe("normalizeTapCharge — envelope", () => {
  test("event id is charge id plus status, so INITIATED and CAPTURED are distinct events", () => {
    expect(normalizeTapCharge(charge("INITIATED")).id).toBe("chg_TS01:INITIATED");
    expect(normalizeTapCharge(charge("CAPTURED")).id).toBe("chg_TS01:CAPTURED");
    expect(normalizeTapCharge(charge("captured")).id).toBe("chg_TS01:CAPTURED");
  });

  test("effectiveAt reads transaction.created as milliseconds", () => {
    expect(normalizeTapCharge(charge("CAPTURED")).effectiveAt.toISOString()).toBe(
      "2024-09-25T08:00:00.000Z",
    );
  });

  test("livemode follows live_mode and defaults to false", () => {
    expect(normalizeTapCharge(charge("CAPTURED")).livemode).toBe(false);
    expect(normalizeTapCharge({ ...charge("CAPTURED"), live_mode: true }).livemode).toBe(true);
    expect(normalizeTapCharge({ ...charge("CAPTURED"), live_mode: undefined }).livemode).toBe(
      false,
    );
  });

  test("data is readable by the shared attribution readers", () => {
    const { data } = normalizeTapCharge(charge("CAPTURED", "subscription_create"));
    expect(extractCustomerId(data)).toBe("cus_TS01");
    expect(extractSchoolIdHint(data)).toBe(SCHOOL_ID);
  });

  test("copies no card data", () => {
    const withCard = {
      ...charge("CAPTURED"),
      card: { first_six: "512345", last_four: "0008", brand: "MASTERCARD" },
    } as TapCharge;
    const { data } = normalizeTapCharge(withCard);
    expect(Object.keys(data).sort()).toEqual(
      ["amount", "currency", "customer", "id", "metadata", "object", "status"].sort(),
    );
  });

  test("refuses a charge with no id, status or creation time", () => {
    expect(() => normalizeTapCharge({ ...charge("CAPTURED"), id: undefined })).toThrow(
      TapChargeShapeError,
    );
    expect(() => normalizeTapCharge({ ...charge("CAPTURED"), status: undefined })).toThrow(
      TapChargeShapeError,
    );
    expect(() => normalizeTapCharge({ ...charge("CAPTURED"), transaction: {} })).toThrow(
      TapChargeShapeError,
    );
  });
});

describe("normalizeTapCharge — what Stripe would have reported and Tap does not", () => {
  const firstCharge = (): TapCharge => ({
    ...charge("CAPTURED", "subscription_create"),
    metadata: {
      school_id: SCHOOL_ID,
      billing_reason: "subscription_create",
      billing_interval: "monthly",
    },
    card: { id: "card_TS01" },
    payment_agreement: { id: "payment_agreement_TS01" },
  });

  test("a paid first charge opens a period of one billing interval from its creation", () => {
    const { data } = normalizeTapCharge(firstCharge());
    // 2024-09-25T08:00:00Z -> 2024-10-25T08:00:00Z
    expect(data.period_start).toBe(1_727_251_200);
    expect(data.period_end).toBe(1_729_843_200);
    expect(extractPeriod(data)?.end.toISOString()).toBe("2024-10-25T08:00:00.000Z");
  });

  test("a paid renewal carries the period the renewal worker charged for", () => {
    const { data } = normalizeTapCharge({
      ...charge("CAPTURED", "subscription_cycle"),
      metadata: {
        billing_reason: "subscription_cycle",
        period_start: "1729843200",
        period_end: "1732521600",
      },
    });
    expect(extractPeriod(data)?.start.toISOString()).toBe("2024-10-25T08:00:00.000Z");
    expect(extractPeriod(data)?.end.toISOString()).toBe("2024-11-25T08:00:00.000Z");
  });

  test("a paid subscription charge carries the saved card and agreement ids", () => {
    expect(normalizeTapCharge(firstCharge()).data.payment_method).toEqual({
      tap_card_id: "card_TS01",
      tap_payment_agreement_id: "payment_agreement_TS01",
    });
  });

  test("a declined charge or a fee payment carries neither period nor card", () => {
    const declined = normalizeTapCharge({ ...firstCharge(), status: "DECLINED" }).data;
    expect(declined.period_start).toBeUndefined();
    expect(declined.payment_method).toBeUndefined();

    const fee = normalizeTapCharge({
      ...firstCharge(),
      metadata: { purpose: "fee_payment", billing_interval: "monthly" },
    }).data;
    expect(fee.period_start).toBeUndefined();
    expect(fee.payment_method).toBeUndefined();
  });

  test("a billing_reason naming an Object prototype key is not a subscription charge", () => {
    for (const reason of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const event = normalizeTapCharge(charge("CAPTURED", reason));
      expect(event.type).toBe("charge.succeeded");
      expect(event.data.payment_method).toBeUndefined();
    }
  });
});
