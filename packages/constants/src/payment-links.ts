/**
 * Online payment links on licence invoices (db/migrations/000220).
 *
 * The super admin pastes a payment link made in the payment provider's own dashboard (today
 * Revolut) onto an invoice, and the school sees a "Pay online" button next to the bank details.
 * Studafy never talks to the provider: the super admin still records the payment by hand once it
 * arrives. Shared by the API (which refuses anything else) and the web console (which checks before
 * sending).
 */

/** Hosts a link may point at: one of these, or a subdomain of one. Extend here for a new provider. */
export const LICENSE_PAYMENT_LINK_HOSTS = ["revolut.com", "revolut.me"] as const;

/** Longest link accepted; the database CHECK uses the same number. */
export const LICENSE_PAYMENT_LINK_MAX_LENGTH = 500;

/** True when `value` is an https URL on an allowed host, with no credentials, within the limit. */
export function isAllowedLicensePaymentLink(value: string): boolean {
  if (value.length === 0 || value.length > LICENSE_PAYMENT_LINK_MAX_LENGTH) return false;
  if (value !== value.trim() || /\s/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return LICENSE_PAYMENT_LINK_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * A licence's AI stops once an instalment is still unpaid this many days after its due date
 * (db/migrations/000233): due 1 March, the AI stops on 31 March (UTC) and resumes when it is paid.
 * Every instalment counts, so a later one going unpaid stops it again.
 *
 * The default only: since 000234 the grace period is a Student AI programme setting the super admin
 * can change (globally or per school), and each licence keeps the value it was signed with in
 * app.school_licenses.nonpayment_grace_days. Code that knows the licence uses that column.
 */
export const LICENSE_NONPAYMENT_GRACE_DAYS = 30;

/** Days before the cutoff the school is warned. */
export const LICENSE_AI_STOP_WARNING_DAYS = 7;

/**
 * The UTC date (YYYY-MM-DD) the AI stops if an instalment due on `dueDate` is still unpaid, for a
 * licence with `graceDays` of grace (its own nonpayment_grace_days).
 */
export function licenseAiStopDate(
  dueDate: string,
  graceDays: number = LICENSE_NONPAYMENT_GRACE_DAYS,
): string {
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  return new Date(due + graceDays * 86_400_000).toISOString().slice(0, 10);
}
