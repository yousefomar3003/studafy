/**
 * Translation of SES configuration-set SNS notifications into the email-event ledger
 * (deliverability R-08).
 *
 * SES publishes one SNS message per event for each unique recipient, with the notification's
 * `Message` field carrying a JSON document like:
 *
 * ```json
 * {
 *   "eventType": "Bounce",
 *   "mail": { "messageId": "...", "destination": ["parent@example.com"] },
 *   "bounce": { "bounceType": "Permanent", "bouncedRecipients": [{ "emailAddress": "parent@example.com" }] }
 * }
 * ```
 *
 * Only three event types are ever delivered to this endpoint — the configuration set subscribes the
 * topic to Bounce, Complaint, and Delivery. Anything else (Send, Open, Click, Rendering Failure)
 * would mean the topic was misconfigured; it is logged and knowingly ignored rather than answered
 * with an error, so a misbehaving subscription cannot wedge SNS's delivery loop.
 *
 * Suppression policy, mirroring what a production sender must do:
 * - Permanent bounce  -> suppress the bounced address. The address is hard-failed; mailing it again
 *   degrades the sending IP's reputation and, eventually, the whole identity's.
 * - Transient bounce  -> record the event, do not suppress. Transient means "try again later", and
 *   SES already performs its own retries before reporting a hard failure.
 * - Undetermined bounce -> record the event, do not suppress. There is not enough information to
 *   judge deliverability, and suppressing on a guess would block mail the recipient may still want.
 * - Complaint         -> suppress every reported recipient. A complaint is a direct report to the
 *   ISP; keeping an address that complained is how senders lose the right to send at all.
 *
 * Addresses are normalized to `lower(trim())` to match the constraint on `app.email_suppressions`
 * and the recipients the dispatcher records on `app.email_deliveries`.
 */

export type EmailEventType = "bounce" | "complaint" | "delivery";
export type EmailSuppressionReason = "bounce" | "complaint";

/** Raised when a notification carries an SES document that cannot be interpreted structurally. */
export class SesEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SesEventError";
  }
}

export interface SesMail {
  messageId?: string;
  destination?: string[];
}

export interface SesEvent {
  eventType?: string;
  mail?: SesMail;
  bounce?: {
    bounceType?: string;
    bouncedRecipients?: { emailAddress?: string }[];
  };
  complaint?: {
    complaintRecipients?: { emailAddress?: string }[];
  };
  [key: string]: unknown;
}

export interface ParsedSesEvent {
  /** Ledger value for `app.email_events.event_type`. */
  eventType: EmailEventType;
  /** SES SendEmail MessageId, which the dispatcher also records on the delivery row. */
  messageId: string;
  /** The raw SES document, stored verbatim on `app.email_events.payload`. */
  payload: Record<string, unknown>;
  /** Whether the recipients should be added to the suppression list. */
  suppress: boolean;
  /** The suppression reason when `suppress` is true, otherwise null. */
  reason: EmailSuppressionReason | null;
  /** Normalized addresses to suppress (empty when `suppress` is false). */
  recipients: string[];
}

/** The SES eventType strings this endpoint understands, mapped to ledger values. */
const EVENT_TYPE_MAP: Record<string, EmailEventType> = {
  Bounce: "bounce",
  Complaint: "complaint",
  Delivery: "delivery",
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
 * Parse an SES event document into what the webhook must record and do.
 *
 * @param message The parsed `Message` field of an SNS Notification (an unknown-shaped JSON value).
 * @returns A parsed event, or `null` when the eventType is knowingly ignored.
 * @throws {SesEventError} When the document is structurally unusable (not an object, missing
 *   messageId, or a bounce/complaint with no recipient to attribute).
 */
export function parseSesEvent(message: unknown): ParsedSesEvent | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new SesEventError("SES event Message is not a JSON object");
  }
  const event = message as SesEvent;

  const eventType = event.eventType;
  const mapped = typeof eventType === "string" ? EVENT_TYPE_MAP[eventType] : undefined;
  if (mapped === undefined) {
    // Knowingly ignored: the subscription is not restricted to the three configured event types.
    return null;
  }

  const messageId = event.mail?.messageId;
  if (typeof messageId !== "string" || messageId.length === 0) {
    throw new SesEventError("SES event is missing mail.messageId");
  }

  const payload = event as Record<string, unknown>;
  const recipients = recipientsFrom(event);

  if (mapped === "bounce") {
    const bounceType = event.bounce?.bounceType;
    const suppress = bounceType === "Permanent";
    return {
      eventType: mapped,
      messageId,
      payload,
      suppress,
      reason: suppress ? "bounce" : null,
      recipients: suppress ? recipients : [],
    };
  }

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

  return {
    eventType: "delivery",
    messageId,
    payload,
    suppress: false,
    reason: null,
    recipients: [],
  };
}

function recipientsFrom(event: SesEvent): string[] {
  if (event.bounce?.bouncedRecipients && event.bounce.bouncedRecipients.length > 0) {
    return normalizeAddresses(
      event.bounce.bouncedRecipients
        .map((recipient) => recipient.emailAddress)
        .filter((address): address is string => typeof address === "string"),
    );
  }
  if (event.complaint?.complaintRecipients && event.complaint.complaintRecipients.length > 0) {
    return normalizeAddresses(
      event.complaint.complaintRecipients
        .map((recipient) => recipient.emailAddress)
        .filter((address): address is string => typeof address === "string"),
    );
  }
  const destination = event.mail?.destination;
  if (Array.isArray(destination)) {
    const addresses = normalizeAddresses(
      destination.filter((address) => typeof address === "string"),
    );
    if (addresses.length === 0) {
      throw new SesEventError("SES event carries no recipient addresses to act on");
    }
    return addresses;
  }
  throw new SesEventError("SES event carries no recipient addresses to act on");
}
