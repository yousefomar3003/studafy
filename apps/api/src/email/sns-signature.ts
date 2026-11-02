import { createVerify } from "node:crypto";

/**
 * Verification of Amazon SNS message signatures (deliverability R-08).
 *
 * SNS signs every message it publishes to an HTTPS endpoint — Notification, SubscriptionConfirmation,
 * and UnsubscribeConfirmation alike — with RSA over SHA1 using a public key it publishes under
 * `https://sns.<region>.amazonaws.com`. The signature covers a canonical rendering of the envelope
 * (documented in "Verifying the signatures of Amazon SNS messages"), never the raw wire bytes: the
 * exact same JSON from a publisher can be re-serialized differently in transit, so SNS defines the
 * message to be signed as the fixed field order below, not the HTTP body.
 *
 * Three checks, in the order they are applied:
 *   1. SignatureVersion must be `1`. It is the only version SNS has ever shipped, and an envelope
 *      with any other value cannot be verified by this path.
 *   2. SigningCertURL must point at SNS's own certificate host in the topic's region. This is the
 *      attack AWS documents for webhooks: the signature proves nothing if the signing key can be
 *      swapped for an attacker's, and the URL is attacker-controlled envelope data. Accepting only
 *      `sns.<region>.amazonaws.com` pins the key to the publisher's region; `sns.amazonaws.com`
 *      (no region) is additionally accepted because SNS has historically served some regional
 *      certificates from it.
 *   3. The base64 `Signature` must verify under the certificate's public key against the canonical
 *      message with RSA-SHA1.
 *
 * The certificate is fetched over HTTPS and cached per URL. SNS rotates signing certificates rarely;
 * an unbounded Map keyed on the URL is bounded by the number of distinct regional certs SNS ever
 * serves (single digits). A cache hit avoids a network round trip per webhook delivery, which
 * matters because bounce handling is on the send path of nothing but is bursty after a campaign.
 */

/** One Amazon SNS envelope as delivered to a subscribed HTTPS endpoint. */
export interface SnsEnvelope {
  Type: string;
  MessageId?: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
}

/** Raised when an envelope fails a structural precondition of verification. */
export class SnsSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnsSignatureError";
  }
}

/**
 * The fields SNS includes in a SignatureVersion-1 message, in signature order. A field present in
 * the envelope contributes `Name\nValue\n`; a field absent contributes nothing. Only these six
 * fields are ever part of the signed message, so any other envelope field (SubscribeURL, for
 * example) is deliberately outside the signed scope.
 */
const SIGNED_FIELDS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;

/**
 * Build the canonical string SNS signs for a SignatureVersion-1 message.
 *
 * @throws {SnsSignatureError} When a signed field is missing or empty. SNS always sets every signed
 *   field except Subject (only some notifications carry one), so a missing Message or MessageId is
 *   not a message SNS published and must not verify.
 */
export function buildSnsCanonicalMessage(envelope: SnsEnvelope): string {
  const parts: string[] = [];
  for (const field of SIGNED_FIELDS) {
    const value = envelope[field];
    if (value === undefined) {
      // Subject is genuinely optional in the envelope; the rest are not.
      if (field === "Subject") continue;
      throw new SnsSignatureError(`SNS envelope is missing signed field ${field}`);
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new SnsSignatureError(`SNS envelope has a non-string or empty signed field ${field}`);
    }
    parts.push(`${field}\n${value}\n`);
  }
  return parts.join("");
}

/**
 * Extract the region from an SNS topic ARN: `arn:aws:sns:<region>:<account>:<name>`.
 * Returns `null` when the ARN is not a well-formed SNS topic ARN.
 */
export function regionFromTopicArn(topicArn: string): string | null {
  const match = /^arn:aws:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9._-]+$/.exec(topicArn);
  return match ? match[1] : null;
}

/**
 * Whether a SigningCertURL is one SNS would serve for the given topic.
 *
 * The URL must be HTTPS, its host must be exactly SNS's own (`sns.amazonaws.com`) or regional
 * (`sns.<region>.amazonaws.com`) with the region matching the topic's own, and the path must be an
 * SNS signing certificate (SNS serves these as `/SimpleNotificationService-<hash>.pem`). The
 * hostname pin is the security control; the scheme and path checks stop a colluding-but-remote host
 * (e.g. an HTTP redirect) from being followed.
 */
export function isAllowedSigningCertUrl(signingCertUrl: string, topicArn: string): boolean {
  let url: URL;
  try {
    url = new URL(signingCertUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hostname !== "sns.amazonaws.com") {
    const region = regionFromTopicArn(topicArn);
    if (region === null || url.hostname !== `sns.${region}.amazonaws.com`) return false;
  }
  return url.pathname.startsWith("/SimpleNotificationService-") && url.pathname.endsWith(".pem");
}

/**
 * Verify an SNS SignatureVersion-1 signature against the envelope's own certificate.
 *
 * @param envelope The parsed SNS message.
 * @param options.fetchCert Injectable certificate fetcher (returns the PEM body). Defaults to a
 *   cached global fetch; tests inject a stub to avoid network access.
 * @returns `true` when the signature verifies, `false` when it does not.
 * @throws {SnsSignatureError} When the envelope fails a structural check (version, URL host) or the
 *   certificate cannot be obtained or parsed.
 */
export async function verifySnsSignature(
  envelope: SnsEnvelope,
  options: { fetchCert?: (url: string) => Promise<string> } = {},
): Promise<boolean> {
  const fetchCert = options.fetchCert ?? cachedFetchCert;

  if (envelope.SignatureVersion !== "1") {
    throw new SnsSignatureError(
      `Unsupported SNS SignatureVersion "${envelope.SignatureVersion ?? "missing"}"`,
    );
  }
  if (!envelope.Signature || !envelope.SigningCertURL) {
    throw new SnsSignatureError("SNS envelope is missing Signature or SigningCertURL");
  }
  if (!isAllowedSigningCertUrl(envelope.SigningCertURL, envelope.TopicArn)) {
    throw new SnsSignatureError("SNS SigningCertURL is not a permitted SNS certificate URL");
  }

  const canonical = buildSnsCanonicalMessage(envelope);
  const publicKeyPem = await fetchCert(envelope.SigningCertURL);

  const verifier = createVerify("RSA-SHA1");
  verifier.update(canonical, "utf8");
  try {
    return verifier.verify(publicKeyPem, envelope.Signature, "base64");
  } catch {
    // An unparseable certificate is the only way verify() throws; an unparseable certificate is a
    // tampered URL, which is the attack the hostname pin exists to stop.
    return false;
  }
}

const certCache = new Map<string, string>();

async function cachedFetchCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached !== undefined) return cached;

  const response = await fetch(url);
  if (!response.ok) {
    throw new SnsSignatureError(
      `Failed to fetch SNS signing certificate (HTTP ${response.status})`,
    );
  }
  const pem = await response.text();
  if (!pem.includes("BEGIN PUBLIC KEY")) {
    throw new SnsSignatureError("SNS signing certificate is not a PEM public key");
  }
  certCache.set(url, pem);
  return pem;
}
