import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an ERPNext webhook HMAC-SHA256 signature. ERPNext signs the raw request body with a
 * shared secret and sends the hex digest in a header. We compare using timing-safe equality
 * to prevent side-channel attacks.
 *
 * @param body - Raw request body as a string (must be the exact bytes ERPNext signed).
 * @param signature - The hex-encoded HMAC digest from the request header.
 * @param secret - The shared webhook secret.
 * @returns `true` if the signature is valid.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");

  // Both strings are hex digests of fixed length — timingSafeEqual is safe and appropriate.
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
