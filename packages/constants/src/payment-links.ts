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
