/**
 * Tap webhook signature (`hashstring` header) verification.
 *
 * Unlike Stripe, Tap does not sign the raw body. It sends an HMAC-SHA256, keyed with the merchant's
 * secret API key, over a fixed concatenation of charge fields:
 *
 *   x_id{id}x_amount{amount}x_currency{currency}x_gateway_reference{reference.gateway}
 *   x_payment_reference{reference.payment}x_status{status}x_created{transaction.created}
 *
 * with `amount` formatted to the currency's decimal places (JOD "15.000", SAR "15.00"). Two
 * consequences shape the rest of the Tap integration:
 *
 *   - The body has to be parsed before it can be verified. Nothing parsed is acted on until the
 *     digest matches.
 *   - `metadata` and `customer` are not covered. A captured genuine body with its metadata edited
 *     still verifies, so the adapter re-reads the charge from Tap before trusting either -- see
 *     `TapAdapter.parseWebhook` in apps/api.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { tapCurrencyExponent } from "./currency";

import type { TapCharge } from "./charge";

/** The string Tap signs, or `null` when the charge lacks a field the digest needs. */
export function buildTapHashInput(charge: TapCharge): string | null {
  const { id, amount, currency, status } = charge;
  const created = charge.transaction?.created;

  if (!id || typeof amount !== "number" || !currency || !status || created === undefined) {
    return null;
  }

  const exponent = tapCurrencyExponent(currency);
  if (exponent === null) return null;

  return (
    `x_id${id}` +
    `x_amount${amount.toFixed(exponent)}` +
    `x_currency${currency}` +
    `x_gateway_reference${charge.reference?.gateway ?? ""}` +
    `x_payment_reference${charge.reference?.payment ?? ""}` +
    `x_status${status}` +
    `x_created${created}`
  );
}

export function computeTapHashString(charge: TapCharge, secretKey: string): string | null {
  const input = buildTapHashInput(charge);
  return input === null ? null : createHmac("sha256", secretKey).update(input).digest("hex");
}

/** Constant-time comparison of the received `hashstring` against the expected digest. */
export function verifyTapHashString(
  charge: TapCharge,
  hashString: string,
  secretKey: string,
): boolean {
  const expected = computeTapHashString(charge, secretKey);
  if (expected === null) return false;

  const received = Buffer.from(hashString.trim().toLowerCase(), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}
