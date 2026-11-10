/**
 * Translation of Resend webhook events into the email-event ledger (deliverability R-08).
 *
 * Resend posts one JSON document per event:
 *
 * ```json
 * {
 *   "type": "email.bounced",
 *   "created_at": "2026-11-09T19:44:00.000Z",
 *   "data": {
 *     "email_id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
 *     "to": ["parent@example.com"],
 *     "bounce": { "type": "Permanent", "subType": "General", "message": "..." }
 *   }
 * }
 * ```
 *
 * `data.email_id` is the id the workers' sender recorded as `app.email_deliveries.message_id`.
 * The endpoint subscribes to email.delivered, email.bounced, email.complained and
 * email.delivery_delayed; only the first three change state. Anything else is logged and knowingly
 * ignored rather than answered with an error, so a widened subscription cannot wedge delivery.
 *
 * Suppression policy, mirroring what a production sender must do:
 * - Permanent bounce  -> suppress the bounced address. The address is hard-failed; mailing it again
 *   degrades the sending domain's reputation.
 * - Transient / Undetermined bounce -> record the event, do not suppress. There is no evidence the
 *   address is dead, and suppressing on a guess would block mail the recipient may still want.
 * - Complaint         -> suppress every recipient. A complaint is a direct report to the mailbox
 *   provider; keeping an address that complained is how senders lose the right to send at all.
 *
 * Addresses are normalized to `lower(trim())` to match the constraint on `app.email_suppressions`
 * and the recipients the dispatcher records on `app.email_deliveries`.
 */

export type EmailEventType = "bounce" | "complaint" | "delivery";
export type EmailSuppressionReason = "bounce" | "complaint";

/** Raised when an event document cannot be interpreted structurally. */
export class EmailEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailEventError";
  }
}

export interface ResendEvent {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    to?: unknown;
    bounce?: { type?: unknown; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ParsedEmailEvent {
  /** Ledger value for `app.email_events.event_type`. */
  eventType: EmailEventType;
  /** Resend email id, which the dispatcher also records on the delivery row. */
  messageId: string;
  /** The raw event document, stored verbatim on `app.email_events.payload`. */
  payload: Record<string, unknown>;
  /** Whether the recipients should be added to the suppression list. */
  suppress: boolean;
  /** The suppression reason when `suppress` is true, otherwise null. */
  reason: EmailSuppressionReason | null;
  /** Normalized addresses to suppress (empty when `suppress` is false). */
  recipients: string[];
}

/** The Resend event types this endpoint acts on, mapped to ledger values. */
const EVENT_TYPE_MAP: Record<string, EmailEventType> = {
  "email.bounced": "bounce",
  "email.complained": "complaint",
  "email.delivered": "delivery",
};

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function normalizeAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const address of addresses) {
    const value = normalizeAddress(address);
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/**
 * Parse a Resend event document into what the webhook must record and do.
 *
 * @returns A parsed event, or `null` when the event type is knowingly ignored.
 * @throws {EmailEventError} When the document is structurally unusable (not an object, missing
 *   data.email_id, or a bounce/complaint with no recipient to attribute).
 */
export function parseResendEvent(document: unknown): ParsedEmailEvent | null {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new EmailEventError("Resend event is not a JSON object");
  }
  const event = document as ResendEvent;

  const mapped = typeof event.type === "string" ? EVENT_TYPE_MAP[event.type] : undefined;
  if (mapped === undefined) return null;

  const messageId = event.data?.email_id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new EmailEventError("Resend event is missing data.email_id");
  }

  const payload = event as Record<string, unknown>;

  if (mapped === "delivery") {
    return { eventType: mapped, messageId, payload, suppress: false, reason: null, recipients: [] };
  }

  const recipients = recipientsFrom(event);
  if (mapped === "complaint") {
    return {
      eventType: mapped,
      messageId,
      payload,
      suppress: true,
      reason: "complaint",
      recipients,
    };
  }

  const suppress = event.data?.bounce?.type === "Permanent";
  return {
    eventType: mapped,
    messageId,
    payload,
    suppress,
    reason: suppress ? "bounce" : null,
    recipients: suppress ? recipients : [],
  };
}

function recipientsFrom(event: ResendEvent): string[] {
  const to = event.data?.to;
  const raw = typeof to === "string" ? [to] : Array.isArray(to) ? to : [];
  const addresses = normalizeAddresses(
    raw.filter((address): address is string => typeof address === "string"),
  );
  if (addresses.length === 0) {
    throw new EmailEventError("Resend event carries no recipient addresses to act on");
  }
  return addresses;
}
