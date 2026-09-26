import { createHmac } from "node:crypto";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { buildTapHashInput, computeTapHashString, verifyTapHashString } from "../signature";

import type { TapCharge } from "../charge";

const SECRET = "sk_test_signature_fixture";

const charge: TapCharge = {
  id: "chg_TS01A1234567890",
  object: "charge",
  amount: 15.5,
  currency: "JOD",
  status: "CAPTURED",
  reference: { gateway: "123456789", payment: "0412233445" },
  transaction: { created: "1727251200000" },
};

/** The digest written out by hand, so the test does not share a code path with what it checks. */
function expectedDigest(input: string): string {
  return createHmac("sha256", SECRET).update(input).digest("hex");
}

describe("Tap hashstring", () => {
  test("signs the documented field concatenation, amount at JOD's three decimals", () => {
    expect(buildTapHashInput(charge)).toBe(
      "x_idchg_TS01A1234567890x_amount15.500x_currencyJODx_gateway_reference123456789" +
        "x_payment_reference0412233445x_statusCAPTUREDx_created1727251200000",
    );
  });

  test("formats two-decimal currencies at two places", () => {
    expect(buildTapHashInput({ ...charge, currency: "SAR", amount: 20 })).toContain(
      "x_amount20.00x_currencySAR",
    );
  });

  test("absent references hash as empty strings rather than 'undefined'", () => {
    const input = buildTapHashInput({ ...charge, reference: undefined });
    expect(input).toContain("x_gateway_referencex_payment_referencex_status");
  });

  test("accepts the correct digest, case-insensitively", () => {
    const digest = expectedDigest(buildTapHashInput(charge)!);
    expect(computeTapHashString(charge, SECRET)).toBe(digest);
    expect(verifyTapHashString(charge, digest, SECRET)).toBe(true);
    expect(verifyTapHashString(charge, digest.toUpperCase(), SECRET)).toBe(true);
  });

  test("rejects a digest made with a different key", () => {
    const forged = createHmac("sha256", "sk_test_other").update(buildTapHashInput(charge)!);
    expect(verifyTapHashString(charge, forged.digest("hex"), SECRET)).toBe(false);
  });

  test("rejects a genuine digest once a signed field is edited", () => {
    const digest = computeTapHashString(charge, SECRET)!;
    expect(verifyTapHashString({ ...charge, status: "DECLINED" }, digest, SECRET)).toBe(false);
    expect(verifyTapHashString({ ...charge, amount: 1500 }, digest, SECRET)).toBe(false);
  });

  // Documents the limitation TapAdapter.parseWebhook exists to close: metadata is not signed.
  test("does not cover metadata, which is why the adapter re-reads the charge", () => {
    const digest = computeTapHashString(charge, SECRET)!;
    const edited = { ...charge, metadata: { school_id: "someone-else" } };
    expect(verifyTapHashString(edited, digest, SECRET)).toBe(true);
  });

  test("refuses to verify a charge missing a signed field or in an unknown currency", () => {
    const digest = computeTapHashString(charge, SECRET)!;
    expect(verifyTapHashString({ ...charge, transaction: undefined }, digest, SECRET)).toBe(false);
    expect(verifyTapHashString({ ...charge, currency: "XYZ" }, digest, SECRET)).toBe(false);
    expect(verifyTapHashString(charge, "short", SECRET)).toBe(false);
  });
});
