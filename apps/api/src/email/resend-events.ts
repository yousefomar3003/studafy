import { createHmac, timingSafeEqual } from "node:crypto";

import { normalizeAddresses } from "./email-events";

import type { ParsedEmailEvent } from "./email-events";

/**
 * Resend email-event webhook: signature check and event parsing.
 *
 * Resend signs every webhook the Svix way: an HMAC-SHA256, keyed by the endpoint's `whsec_` secret
 * (base64 after the prefix), over `${svix-id}.${svix-timestamp}.${raw body}`, sent base64 as one or
 * more space-separated `v1,<signature>` entries in `svix-signature`. A delivery older or newer than
 * five minutes is refused, so a captured request cannot be replayed later.
 *
 * Parsing maps Resend's events onto the email-event ledger (`ParsedEmailEvent`):
 * `email.bounced` is a hard bounce (soft bounces arrive as `email.delivery_delayed`, which is
 * ignored), `email.complained` a spam complaint, `email.delivered` a delivery. The message id is
 * Resend's `data.email_id`, the id the workers' Resend sender recorded on the delivery row.
 */

const TOLERANCE_SECONDS = 5 * 60;

export class ResendEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResendEventError";
  }
}

export interface ResendSignatureHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/** Whether the headers carry a valid, current Svix signature over `rawBody` for `secret`. */
export function verifyResendSignature(
  rawBody: string,
  headers: ResendSignatureHeaders,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(nowSeconds - sentAt) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();

  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) return false;
    const candidate = Buffer.from(value, "base64");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

interface ResendEvent {
  type?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    bounce?: { type?: unknown };
  };
}

/**
 * Parse a Resend webhook body into what the webhook must record and do.
 *
 * @returns The parsed event, or `null` for an event type this endpoint knowingly ignores.
 * @throws {ResendEventError} When the body is not usable (no email id, or a bounce/complaint with no
 *   recipient to suppress).
 */
export function parseResendEvent(body: unknown): ParsedEmailEvent | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ResendEventError("Resend event is not a JSON object");
  }
  const event = body as ResendEvent;

  const eventType =
    event.type === "email.bounced"
      ? "bounce"
      : event.type === "email.complained"
        ? "complaint"
        : event.type === "email.delivered"
          ? "delivery"
          : null;
  if (eventType === null) return null;

  const messageId = event.data?.email_id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new ResendEventError("Resend event is missing data.email_id");
  }

  const payload = event as Record<string, unknown>;
  if (eventType === "delivery") {
    return { eventType, messageId, payload, suppress: false, reason: null, recipients: [] };
  }

  const to = Array.isArray(event.data?.to) ? event.data.to : [];
  const recipients = normalizeAddresses(
    to.filter((address): address is string => typeof address === "string"),
  );
  if (recipients.length === 0) {
    throw new ResendEventError("Resend event carries no recipient addresses to act on");
  }

  // email.bounced is a permanent bounce; a bounce Resend itself labels transient is recorded but
  // does not suppress the address.
  const suppress = eventType === "complaint" || event.data?.bounce?.type !== "Transient";
  return {
    eventType,
    messageId,
    payload,
    suppress,
    reason: suppress ? eventType : null,
    recipients: suppress ? recipients : [],
  };
}
