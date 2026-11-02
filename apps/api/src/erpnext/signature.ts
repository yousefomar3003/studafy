import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The two headers an ERPNext webhook signature can arrive in. Frappe's own Webhook doctype (what
 * every school's site actually sends -- infra/deploy/erpnext/seed/provision.py installs them) puts a
 * base64 HMAC-SHA256 of the body in `X-Frappe-Webhook-Signature`. `X-ERPNext-Signature` with a hex
 * digest is the form this API documented first; both carry the same HMAC.
 */
export const WEBHOOK_SIGNATURE_HEADERS = [
  "x-frappe-webhook-signature",
  "x-erpnext-signature",
] as const;

/** The first signature header present on a request, or null. */
export function webhookSignatureFrom(header: (name: string) => string | undefined): string | null {
  for (const name of WEBHOOK_SIGNATURE_HEADERS) {
    const value = header(name);
    if (value) return value;
  }
  return null;
}

/**
 * Verify an ERPNext webhook HMAC-SHA256 signature over the raw request body, accepting the digest hex
 * or base64 encoded. Compared with timing-safe equality to prevent side-channel attacks.
 *
 * @param body - Raw request body as a string (must be the exact bytes ERPNext signed).
 * @param signature - The HMAC digest from the request header, hex or base64.
 * @param secret - The shared webhook secret.
 * @returns `true` if the signature is valid.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(body).digest();
  const given = /^[0-9a-f]{64}$/i.test(signature)
    ? Buffer.from(signature, "hex")
    : Buffer.from(signature, "base64");

  return given.length === expected.length && timingSafeEqual(given, expected);
}
