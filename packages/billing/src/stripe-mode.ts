/**
 * Which Stripe account mode a secret key opens: live, or Sandbox (test). Stripe prefixes every key
 * with its mode -- `sk_live_` / `rk_live_` for live, `sk_test_` / `rk_test_` for a Sandbox or test
 * mode -- so the mode is read from the key once at boot rather than configured separately, and can
 * never disagree with the key actually in use (docs/billing/stripe-modes.md).
 */

export type StripeMode = "live" | "sandbox";

/**
 * The mode a Stripe secret (or restricted) key belongs to, or null for a value that is not a Stripe
 * key at all (a test double's placeholder): code then makes no mode decision.
 */
export function stripeModeFromKey(secretKey: string): StripeMode | null {
  if (/^(sk|rk)_live_/.test(secretKey)) return "live";
  if (/^(sk|rk)_test_/.test(secretKey)) return "sandbox";
  return null;
}

/** `livemode` as Stripe objects report it: true for live, false for Sandbox. */
export function isLiveStripeMode(mode: StripeMode): boolean {
  return mode === "live";
}
