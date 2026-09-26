// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { CodedHttpException } from "../../../coded-http-exception";
import {
  resolveProviderForCountry,
  selectPaymentProvider,
  selectPaymentProviderForSchool,
  TAP_COUNTRY_CODES,
} from "../payment-provider-routing";
import { retryJobId } from "../routes/webhook-routes";

import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { PaymentProviderPort } from "../ports/payment-provider";
import type { TransactionSql } from "postgres";

const stripe = { name: "stripe-port" } as unknown as PaymentProviderPort;
const tap = { name: "tap-port" } as unknown as PaymentProviderPort;
const both: PaymentProviderRegistry = { stripe, tap };

/** A transaction that answers every query with the given rows. */
function txReturning(rows: unknown[]): TransactionSql {
  return (() => Promise.resolve(rows)) as unknown as TransactionSql;
}

function thrown(fn: () => unknown): CodedHttpException {
  try {
    fn();
  } catch (error) {
    return error as CodedHttpException;
  }
  throw new Error("expected a throw");
}

describe("resolveProviderForCountry", () => {
  test.each(["JO", "KW", "SA", "BH", "AE", "QA", "OM", "EG"])("%s routes to Tap", (country) => {
    expect(resolveProviderForCountry(country)).toBe("tap");
  });

  test.each(["US", "GB", "DE", "TR", "LB"])("%s routes to Stripe", (country) => {
    expect(resolveProviderForCountry(country)).toBe("stripe");
  });

  test("is case-insensitive", () => {
    expect(resolveProviderForCountry("jo")).toBe("tap");
  });

  test("the Tap list is exactly the eight MENA markets", () => {
    expect([...TAP_COUNTRY_CODES].sort()).toEqual(["AE", "BH", "EG", "JO", "KW", "OM", "QA", "SA"]);
  });
});

describe("selectPaymentProvider", () => {
  test("returns the region's adapter", () => {
    expect(selectPaymentProvider(both, "JO")).toEqual({ name: "tap", port: tap });
    expect(selectPaymentProvider(both, "US")).toEqual({ name: "stripe", port: stripe });
  });

  test("a Tap-region school with no Tap adapter is a 503, never a silent Stripe fallback", () => {
    const error = thrown(() => selectPaymentProvider({ stripe, tap: null }, "JO"));
    expect(error).toBeInstanceOf(CodedHttpException);
    expect(error.status).toBe(503);
    expect(error.code).toBe("TAP_NOT_CONFIGURED");
  });

  test("a Stripe-region school with no Stripe adapter is a 503 naming Stripe", () => {
    const error = thrown(() => selectPaymentProvider({ stripe: null, tap }, "US"));
    expect(error.status).toBe(503);
    expect(error.code).toBe("STRIPE_NOT_CONFIGURED");
  });
});

describe("selectPaymentProviderForSchool", () => {
  test("routes by the school's country", async () => {
    const jordan = await selectPaymentProviderForSchool(
      txReturning([{ alpha2_code: "JO" }]),
      both,
      "school-1",
    );
    expect(jordan.name).toBe("tap");

    const us = await selectPaymentProviderForSchool(
      txReturning([{ alpha2_code: "US" }]),
      both,
      "school-2",
    );
    expect(us.name).toBe("stripe");
  });

  test("an unknown school is a 404", async () => {
    const error: unknown = await selectPaymentProviderForSchool(
      txReturning([]),
      both,
      "missing",
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodedHttpException);
    expect((error as CodedHttpException).status).toBe(404);
  });
});

describe("retryJobId", () => {
  // BullMQ 5 throws "Custom Id cannot contain :" for any custom job id containing ':' unless it
  // splits into exactly three parts (classes/job.js validateOptions). Both Stripe's old
  // `stripe:evt_...` and a Tap `chg_...:CAPTURED` id would be refused.
  const acceptedByBullMq = (id: string) => !id.includes(":") || id.split(":").length === 3;

  test("produces ids BullMQ accepts for both providers", () => {
    expect(acceptedByBullMq(retryJobId("stripe", "evt_1"))).toBe(true);
    expect(acceptedByBullMq(retryJobId("tap", "chg_TS01:CAPTURED"))).toBe(true);
  });

  test("keeps providers and statuses distinct", () => {
    expect(retryJobId("tap", "chg_1:CAPTURED")).not.toBe(retryJobId("tap", "chg_1:DECLINED"));
    expect(retryJobId("tap", "x")).not.toBe(retryJobId("stripe", "x"));
  });
});
