/**
 * The email-event ledger's shared vocabulary (deliverability R-08): what a provider's bounce,
 * complaint, or delivery notification becomes once parsed (resend-events.ts), and how addresses are
 * normalized.
 *
 * Suppression policy, mirroring what a production sender must do:
 * - Permanent bounce  -> suppress the bounced address. The address is hard-failed; mailing it again
 *   degrades the sending domain's reputation.
 * - Transient bounce  -> record the event, do not suppress. Transient means "try again later".
 * - Complaint         -> suppress every reported recipient. A complaint is a direct report to the
 *   ISP; keeping an address that complained is how senders lose the right to send at all.
 *
 * Addresses are normalized to `lower(trim())` to match the constraint on `app.email_suppressions`
 * and the recipients the dispatcher records on `app.email_deliveries`.
 */

export type EmailEventType = "bounce" | "complaint" | "delivery";
export type EmailSuppressionReason = "bounce" | "complaint";

export interface ParsedEmailEvent {
  /** Ledger value for `app.email_events.event_type`. */
  eventType: EmailEventType;
  /** The provider's message id, which the dispatcher also records on the delivery row. */
  messageId: string;
  /** The raw provider document, stored verbatim on `app.email_events.payload`. */
  payload: Record<string, unknown>;
  /** Whether the recipients should be added to the suppression list. */
  suppress: boolean;
  /** The suppression reason when `suppress` is true, otherwise null. */
  reason: EmailSuppressionReason | null;
  /** Normalized addresses to suppress (empty when `suppress` is false). */
  recipients: string[];
}

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
