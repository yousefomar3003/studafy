import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verification of Resend webhook signatures (deliverability R-08).
 *
 * Resend delivers webhooks through Svix, which signs each request with the endpoint's signing
 * secret (`whsec_<base64 key>`). Three headers carry the proof:
 *
 * - `svix-id`        — unique per message, stable across redeliveries
 * - `svix-timestamp` — Unix seconds when the attempt was signed
 * - `svix-signature` — space-separated `v1,<base64 HMAC-SHA256>` entries (several during a secret
 *   rotation)
 *
 * The signed content is `${id}.${timestamp}.${rawBody}`, so the exact bytes received must be
 * verified — never a re-serialized parse. The timestamp window bounds replay of a captured request.
 */

/** How far a signature's timestamp may sit from our clock, either way. Svix's own default. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const SECRET_PREFIX = "whsec_";

export class ResendSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendSignatureError";
  }
}

export interface ResendSignatureHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Verify one webhook request.
 *
 * @throws {ResendSignatureError} when a header is missing, the timestamp is outside the tolerance,
 *   the secret is malformed, or no `v1` signature matches.
 */
export function verifyResendSignature(
  secret: string,
  headers: ResendSignatureHeaders,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    throw new ResendSignatureError("missing svix-id, svix-timestamp, or svix-signature header");
  }

  if (!/^\d+$/.test(timestamp)) {
    throw new ResendSignatureError("svix-timestamp is not a Unix timestamp");
  }
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new ResendSignatureError("svix-timestamp is outside the replay tolerance");
  }

  const key = decodeSecret(secret);
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();

  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const candidate = Buffer.from(value, "base64");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return;
  }
  throw new ResendSignatureError("no v1 signature matched");
}

function decodeSecret(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) {
    throw new ResendSignatureError("RESEND_WEBHOOK_SECRET is not a valid signing secret");
  }
  return key;
}

/** Produce a valid `svix-signature` value. For tests and local tooling that replay events. */
export function signResendPayload(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
): string {
  const digest = createHmac("sha256", decodeSecret(secret))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  return `v1,${digest}`;
}
