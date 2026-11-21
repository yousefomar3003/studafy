/**
 * Email templates for the transactional channel (deliverability R-08).
 *
 * Every template is a pure function of plain data: given a school name, a link, and the payload
 * fields it needs, it returns a fully-rendered { subject, text, html }. There is no template
 * engine and no I/O — the dispatcher renders inline before handing the message to the Resend sender,
 * and unit tests exercise each template without a database.
 *
 * All copy is English-only (a localization pass is a separate concern, not this ticket).
 */

/**
 * Mirrors the app.email_template enum. "digest" and "alert" remain only because existing
 * app.email_deliveries rows carry them: Studafy sends no notification email, so nothing renders
 * either any more.
 */
export type EmailTemplate =
  | "invitation"
  | "verification"
  | "dunning"
  | "digest"
  | "alert"
  | "seat-drift"
  | "ai-subscription-paused"
  | "ai-subscription-resumed"
  | "account-deletion-verification"
  | "account-deletion-confirmation"
  | "ai-store-purchase-confirmation"
  | "license-instalment-overdue"
  | "license-ai-stop-warning"
  | "license-ai-stopped";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface InvitationEmailData {
  schoolName: string;
  actionUrl: string;
  /** ISO date-time the invitation expires, when known. Shown as a courtesy, never enforced here. */
  expiresAt?: string;
}

export interface VerificationEmailData {
  schoolName: string;
  actionUrl: string;
  expiresAt: string;
}

export interface DunningEmailData {
  schoolName: string;
  studentName: string;
  /** Amount in minor units, e.g. 100000 = 1000.00 of the school's currency. */
  amountMinor: number;
  dueDate: string;
}

/**
 * The school-facing dunning reminder (ST-134), for the platform subscription's grace period.
 *
 * Distinct from `DunningEmailData` above, which anticipates a student-fee dunning flow and is not
 * yet wired to any event. A reminder about the school's own bill has no student and no reliable
 * amount -- the subscription row names its plan but not the price -- so it carries the plan name,
 * the period that went unpaid, and the lockout deadline instead.
 */
export interface SubscriptionDunningEmailData {
  schoolName: string;
  /** The display name of the plan the school is billed for, e.g. "Growth". */
  planName: string;
  /** ISO datetime of the period end that went unpaid. */
  dueDate: string;
  /** ISO datetime after which the school loses access. */
  gracePeriodEndsAt: string;
}

/**
 * The seat-drift report (ST-136), for the platform subscription's nightly seat reconciliation.
 *
 * One report per reconciliation, addressed to the school's ORG_ADMINs. `direction` distinguishes
 * the two drift cases: an upgrade bills a prorated charge now (`proratedAmountMinor`/`currency`),
 * a downgrade takes effect at the next renewal (`effectivePeriodEnd`).
 */
export interface SeatDriftEmailData {
  schoolName: string;
  /** The display name of the plan the school is billed for, e.g. "Growth". */
  planName: string;
  activeSeatCount: number;
  billedSeatCount: number;
  direction: "upgrade" | "downgrade";
  proratedAmountMinor: number | null;
  currency: string | null;
  effectivePeriodEnd: string | null;
}

/**
 * The AI-subscription pause/resume notification, for a school-suspension/reactivation event. Sent
 * to the student directly (not to the school's ORG_ADMINs, unlike the dunning/seat-drift templates
 * above): a student's own AI access is what changed.
 */
export interface AiSubscriptionPauseResumeEmailData {
  schoolName: string;
}

/**
 * The one-time link from the public deletion page (ST-302). One link can cover accounts in several
 * schools, so the email names every one of them rather than carrying one school's header.
 */
export interface AccountDeletionVerificationEmailData {
  schoolNames: string[];
  actionUrl: string;
  expiresAt: string;
}

/** Sent once a deletion is accepted, from either entry point (account settings or the web page). */
export interface AccountDeletionConfirmationEmailData {
  schoolName: string;
  /** ISO datetime by which personal data will have been erased. */
  completesBy: string;
}

/**
 * The confirmation, on a durable medium, of an AI add-on bought in the app and of the student's
 * waiver of the 14-day right of withdrawal (Directive 2011/83/EU art. 16(m); Terms of Service 7.7).
 * Sent to the student once per purchase; a student without an email address sees the same facts in
 * the app instead.
 */
export interface AiStorePurchaseConfirmationEmailData {
  /** Where it was bought: "apple" (App Store) or "google" (Google Play). */
  platform: "apple" | "google";
  /** ISO datetime the student asked for it to start now and acknowledged losing the right. */
  acknowledgedAt: string;
  /** ISO datetime the purchase was confirmed and the add-on started. */
  recordedAt: string;
  /** The Terms of Service version (its `Last updated` date) the purchase was made under. */
  termsVersion: string;
  /** The public Terms of Service page. */
  termsUrl: string;
}

/** The one piece of user-controlled content that reaches the HTML shell. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatAmountMinor(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

/** The logo artwork's own navy (same value as the web app's `.brand-logo-badge`). */
const BRAND_NAVY = "#161551";
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/**
 * The white wordmark, served unhashed from apps/web/public/email/ so mail clients can fetch it.
 * Always the production host: email images must resolve for every recipient, whichever
 * environment sent the message.
 */
const LOGO_URL = "https://app.studafy.com/email/studafy-logo.png";

/**
 * The shared frame every transactional email renders inside: a navy brand header carrying the
 * Studafy logo, the school name as an eyebrow, the body, and a short footer. Table layout and
 * inline styles only, so it holds up in Outlook and Gmail alike.
 */
function shell(schoolName: string, bodyHtml: string): string {
  const safeSchool = escapeHtml(schoolName);
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#eef0f6;padding:32px 12px">` +
    `<tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e6ef">` +
    `<tr><td style="background-color:${BRAND_NAVY};padding:22px 32px">` +
    `<img src="${LOGO_URL}" alt="Studafy" width="97" height="30" style="display:block;height:30px;width:auto;border:0;outline:none;color:#ffffff;font-family:${FONT_STACK};font-size:20px;font-weight:bold">` +
    `</td></tr>` +
    `<tr><td style="padding:32px 32px 8px;font-family:${FONT_STACK}">` +
    `<p style="margin:0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280">${safeSchool}</p>` +
    `</td></tr>` +
    `<tr><td style="padding:8px 32px 32px;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:#374151">${bodyHtml}</td></tr>` +
    `</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">` +
    `<tr><td style="padding:20px 32px;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:#8a91a3;text-align:center">` +
    `Sent by Studafy on behalf of ${safeSchool}.<br>&copy; Studafy. All rights reserved.` +
    `</td></tr></table>` +
    `</td></tr></table>`
  );
}

/** A table-based ("bulletproof") button, so Outlook keeps the padding and background. */
function button(actionUrl: string, label: string): string {
  const safeUrl = escapeHtml(actionUrl);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0"><tr>` +
    `<td style="border-radius:10px;background-color:${BRAND_NAVY}">` +
    `<a href="${safeUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;border-radius:10px;font-family:${FONT_STACK};font-size:15px;font-weight:600">${escapeHtml(label)}</a>` +
    `</td></tr></table>`
  );
}

/** The "button does not work" fallback, set apart so a long URL doesn't swamp the message. */
function linkFallback(actionUrl: string): string {
  const safeUrl = escapeHtml(actionUrl);
  return (
    `<p style="margin:24px 0 8px;font-size:13px;color:#6b7280">If the button doesn't work, copy and paste this link into your browser:</p>` +
    `<p style="margin:0;padding:12px 14px;background-color:#f5f6fa;border:1px solid #e3e6ef;border-radius:8px;font-size:12px;line-height:1.5;word-break:break-all"><a href="${safeUrl}" style="color:${BRAND_NAVY};text-decoration:underline">${safeUrl}</a></p>`
  );
}

/** A reader-friendly expiry, e.g. "28 November 2026 at 11:37 UTC". */
function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${day} at ${time} UTC`;
}

function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toUTCString();
}

export function renderInvitationEmail(data: InvitationEmailData): RenderedEmail {
  const safeSchool = escapeHtml(data.schoolName);
  const expiryHtml = data.expiresAt
    ? `<p style="margin:0;font-size:13px;color:#6b7280">This invitation expires on <strong style="color:#374151">${escapeHtml(formatExpiry(data.expiresAt))}</strong>.</p>`
    : "";
  const bodyHtml =
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;font-weight:700;color:${BRAND_NAVY}">You're invited to join Studafy</h1>` +
    `<p style="margin:0"><strong style="color:#111827">${safeSchool}</strong> has invited you to join their school on Studafy. Accept the invitation to set up your account and get started.</p>` +
    button(data.actionUrl, "Accept invitation") +
    expiryHtml +
    `<hr style="margin:24px 0 0;border:0;border-top:1px solid #e3e6ef">` +
    linkFallback(data.actionUrl) +
    `<p style="margin:20px 0 0;font-size:13px;color:#6b7280">If you weren't expecting this invitation, you can safely ignore this email.</p>`;
  return {
    subject: `You're invited to ${data.schoolName}`,
    text: `You have been invited to join ${data.schoolName} on Studafy.\n\nAccept your invitation here: ${data.actionUrl}\n${data.expiresAt ? `\nThis invitation expires on ${formatExpiry(data.expiresAt)}.` : ""}\n\nIf you weren't expecting this invitation, you can safely ignore this email.`,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderVerificationEmail(data: VerificationEmailData): RenderedEmail {
  const bodyHtml = `<p>Confirm the contact email for ${escapeHtml(data.schoolName)} to finish setting up your account.</p>${button(data.actionUrl, "Verify email")}<p>If the button does not work, open this link in your browser: <a href="${escapeHtml(data.actionUrl)}">${escapeHtml(data.actionUrl)}</a></p><p>This link expires on ${formatDateLabel(data.expiresAt)}.</p>`;
  return {
    subject: `Verify your email for ${data.schoolName}`,
    text: `Confirm the contact email for ${data.schoolName} to finish setting up your account.\n\nVerify here: ${data.actionUrl}\n\nThis link expires on ${formatDateLabel(data.expiresAt)}.`,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderDunningEmail(data: DunningEmailData): RenderedEmail {
  const text = `A payment of ${formatAmountMinor(data.amountMinor)} for ${data.studentName} was due on ${formatDateLabel(data.dueDate)} and is now overdue. Please arrange payment through the school portal.`;
  const bodyHtml = `<p>A payment of <strong>${escapeHtml(formatAmountMinor(data.amountMinor))}</strong> for ${escapeHtml(data.studentName)} was due on ${formatDateLabel(data.dueDate)} and is now overdue.</p><p>Please arrange payment through the school portal.</p>`;
  return {
    subject: `Payment due reminder for ${data.studentName}`,
    text,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderSubscriptionDunningEmail(data: SubscriptionDunningEmailData): RenderedEmail {
  const text = `Your Studafy subscription payment for the ${data.planName} plan was due on ${formatDateLabel(data.dueDate)} and is now overdue. ${data.schoolName} will lose access on ${formatDateLabel(data.gracePeriodEndsAt)} unless payment is arranged. Please contact your billing contact or the Studafy support team.`;
  const bodyHtml = `<p>Your Studafy subscription payment for the <strong>${escapeHtml(data.planName)}</strong> plan was due on ${formatDateLabel(data.dueDate)} and is now overdue.</p><p>${escapeHtml(data.schoolName)} will lose access on <strong>${formatDateLabel(data.gracePeriodEndsAt)}</strong> unless payment is arranged.</p><p>Please contact your billing contact or the Studafy support team.</p>`;
  return {
    subject: `Action required: ${data.schoolName}'s Studafy payment is overdue`,
    text,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderSeatDriftEmail(data: SeatDriftEmailData): RenderedEmail {
  const delta = data.activeSeatCount - data.billedSeatCount;
  if (data.direction === "upgrade") {
    const amountLabel =
      data.proratedAmountMinor !== null && data.currency !== null
        ? `${formatAmountMinor(data.proratedAmountMinor)} ${data.currency.toUpperCase()}`
        : "";
    const text = `${data.schoolName} now has ${data.activeSeatCount} enrolled students but pays for ${data.billedSeatCount} ${data.billedSeatCount === 1 ? "seat" : "seats"} on the ${data.planName} plan. We have added ${delta} ${delta === 1 ? "seat" : "seats"} to bring your plan in line with your enrolment.${amountLabel ? ` A prorated charge of ${amountLabel} has been billed immediately.` : ""}`;
    const bodyHtml = `<p>${escapeHtml(data.schoolName)} now has <strong>${data.activeSeatCount}</strong> enrolled students but pays for <strong>${data.billedSeatCount}</strong> ${data.billedSeatCount === 1 ? "seat" : "seats"} on the <strong>${escapeHtml(data.planName)}</strong> plan.</p><p>We have added <strong>${delta}</strong> ${delta === 1 ? "seat" : "seats"} to bring your plan in line with your enrolment.${amountLabel ? ` A prorated charge of <strong>${escapeHtml(amountLabel)}</strong> has been billed immediately.` : ""}</p>`;
    return {
      subject: `${data.schoolName}'s Studafy seats have been updated`,
      text,
      html: shell(data.schoolName, bodyHtml),
    };
  }

  const effectiveLabel = data.effectivePeriodEnd
    ? ` at the next renewal (${formatDateLabel(data.effectivePeriodEnd)})`
    : "";
  const text = `${data.schoolName} now has ${data.activeSeatCount} enrolled students but pays for ${data.billedSeatCount} ${data.billedSeatCount === 1 ? "seat" : "seats"} on the ${data.planName} plan. We will reduce your plan to ${data.activeSeatCount} ${data.activeSeatCount === 1 ? "seat" : "seats"}${effectiveLabel}. Unused seats stop billing from that date.`;
  const bodyHtml = `<p>${escapeHtml(data.schoolName)} now has <strong>${data.activeSeatCount}</strong> enrolled students but pays for <strong>${data.billedSeatCount}</strong> ${data.billedSeatCount === 1 ? "seat" : "seats"} on the <strong>${escapeHtml(data.planName)}</strong> plan.</p><p>We will reduce your plan to <strong>${data.activeSeatCount}</strong> ${data.activeSeatCount === 1 ? "seat" : "seats"}${effectiveLabel}. Unused seats stop billing from that date.</p>`;
  return {
    subject: `${data.schoolName}'s Studafy seats have been updated`,
    text,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderAiSubscriptionPausedEmail(
  data: AiSubscriptionPauseResumeEmailData,
): RenderedEmail {
  const text = `Your AI study assistant on Studafy has been paused because ${data.schoolName} is currently suspended. It will resume automatically once ${data.schoolName} is reactivated. Contact your school administrator for details.`;
  const bodyHtml = `<p>Your AI study assistant on Studafy has been paused because <strong>${escapeHtml(data.schoolName)}</strong> is currently suspended.</p><p>It will resume automatically once ${escapeHtml(data.schoolName)} is reactivated. Contact your school administrator for details.</p>`;
  return {
    subject: "Your Studafy AI access has been paused",
    text,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderAiSubscriptionResumedEmail(
  data: AiSubscriptionPauseResumeEmailData,
): RenderedEmail {
  const text = `Good news: ${data.schoolName} has been reactivated, and your AI study assistant on Studafy is available again.`;
  const bodyHtml = `<p>Good news: <strong>${escapeHtml(data.schoolName)}</strong> has been reactivated, and your AI study assistant on Studafy is available again.</p>`;
  return {
    subject: "Your Studafy AI access has resumed",
    text,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderAccountDeletionVerificationEmail(
  data: AccountDeletionVerificationEmailData,
): RenderedEmail {
  const schools = data.schoolNames.join(", ");
  const expires = formatDateLabel(data.expiresAt);
  const text = `We received a request to delete the Studafy account registered to this email address at: ${schools}.\n\nTo delete it, open this link and confirm: ${data.actionUrl}\n\nDeleting signs you out everywhere and cannot be undone. The link expires on ${expires}.\n\nIf you did not ask for this, ignore this email. Nothing changes unless the link is used.`;
  const bodyHtml = `<p>We received a request to delete the Studafy account registered to this email address at: <strong>${escapeHtml(schools)}</strong>.</p>${button(data.actionUrl, "Review and delete")}<p>If the button does not work, open this link in your browser: <a href="${escapeHtml(data.actionUrl)}">${escapeHtml(data.actionUrl)}</a></p><p>Deleting signs you out everywhere and cannot be undone. The link expires on ${expires}.</p><p>If you did not ask for this, ignore this email. Nothing changes unless the link is used.</p>`;
  return {
    subject: "Confirm deletion of your Studafy account",
    text,
    html: shell("Studafy", bodyHtml),
  };
}

export function renderAccountDeletionConfirmationEmail(
  data: AccountDeletionConfirmationEmailData,
): RenderedEmail {
  const completesBy = formatDateLabel(data.completesBy);
  const text = `Your Studafy account at ${data.schoolName} has been deleted. You have been signed out on every device.\n\nYour name, contact details and profile will be erased by ${completesBy}. ${data.schoolName} keeps only the records it is legally required to: grades and attendance without your name or contact details, financial records, and its audit log.\n\nIf you did not ask for this, contact ${data.schoolName} straight away.`;
  const bodyHtml = `<p>Your Studafy account at <strong>${escapeHtml(data.schoolName)}</strong> has been deleted. You have been signed out on every device.</p><p>Your name, contact details and profile will be erased by <strong>${completesBy}</strong>. ${escapeHtml(data.schoolName)} keeps only the records it is legally required to: grades and attendance without your name or contact details, financial records, and its audit log.</p><p>If you did not ask for this, contact ${escapeHtml(data.schoolName)} straight away.</p>`;
  return {
    subject: "Your Studafy account has been deleted",
    text,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderAiStorePurchaseConfirmationEmail(
  data: AiStorePurchaseConfirmationEmailData,
): RenderedEmail {
  const store = data.platform === "apple" ? "the App Store" : "Google Play";
  const acknowledged = formatDateLabel(data.acknowledgedAt);
  const started = formatDateLabel(data.recordedAt);
  const intro = `Thank you for buying the Studafy AI Study Assistant through ${store}. It started on ${started}.`;
  const waiver = `Before you bought it, on ${acknowledged}, you asked for the AI Study Assistant to start straight away and confirmed that you understand you lose your 14-day right to cancel once it starts.`;
  const renewal = `The subscription renews every month until you cancel it in ${store}. Refunds of store purchases are handled by ${store} under its own refund policy. If the service is faulty, your legal rights are not affected.`;
  const terms = `Your purchase is under the Studafy Terms of Service last updated ${data.termsVersion}, section 7.`;
  const keep = "Please keep this email for your records.";
  const text = `${intro}\n\n${waiver}\n\n${renewal}\n\n${terms} Read them here: ${data.termsUrl}\n\n${keep}`;
  const bodyHtml = `<p>${escapeHtml(intro)}</p><p><strong>${escapeHtml(waiver)}</strong></p><p>${escapeHtml(renewal)}</p><p>${escapeHtml(terms)} <a href="${escapeHtml(data.termsUrl)}">Read the Terms of Service</a>.</p><p>${escapeHtml(keep)}</p>`;
  return {
    subject: "Your Studafy AI Study Assistant purchase",
    text,
    html: shell("Studafy", bodyHtml),
  };
}

export interface SalesInquiryEmailData {
  fullName: string;
  email: string;
  phone: string | null;
  schoolName: string;
  jobTitle: string | null;
  country: string | null;
  studentCount: number | null;
  message: string | null;
  sourcePath: string | null;
  submittedAt: string;
  /** The platform console's inquiries page. */
  consoleUrl: string;
}

/** Staff-facing: a prospective school used the marketing site's "Talk to us" form. */
export function renderSalesInquiryEmail(data: SalesInquiryEmailData): RenderedEmail {
  const fields: [string, string | null][] = [
    ["Name", data.fullName],
    ["Email", data.email],
    ["Phone", data.phone],
    ["School", data.schoolName],
    ["Role", data.jobTitle],
    ["Country", data.country],
    ["Students", data.studentCount === null ? null : String(data.studentCount)],
    ["Submitted from", data.sourcePath],
    ["Received", formatDateLabel(data.submittedAt)],
  ];
  const present = fields.filter((field): field is [string, string] => field[1] !== null);

  const rowsHtml = present
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const messageHtml = data.message
    ? `<p style="margin:16px 0 4px;color:#6b7280">Message</p><p style="margin:0;white-space:pre-wrap">${escapeHtml(data.message)}</p>`
    : "";
  const bodyHtml = `<p>New "Talk to us" inquiry from <strong>${escapeHtml(data.fullName)}</strong> at <strong>${escapeHtml(data.schoolName)}</strong>.</p><table role="presentation" cellpadding="0" cellspacing="0">${rowsHtml}</table>${messageHtml}${button(data.consoleUrl, "Open in platform console")}<p>Reply to this email to answer ${escapeHtml(data.fullName)} directly.</p>`;

  const text = [
    `New "Talk to us" inquiry from ${data.fullName} at ${data.schoolName}.`,
    "",
    ...present.map(([label, value]) => `${label}: ${value}`),
    ...(data.message ? ["", "Message:", data.message] : []),
    "",
    `Open in the platform console: ${data.consoleUrl}`,
  ].join("\n");

  return {
    subject: `New inquiry: ${data.schoolName} (${data.fullName})`,
    text,
    html: shell("Studafy sales", bodyHtml),
  };
}

export interface SchoolApplicationEmailData {
  applicantName: string;
  applicantEmail: string;
  applicantJobTitle: string | null;
  applicantPhone: string;
  /** "google" | "microsoft" -- which account they signed up with. */
  provider: string;
  schoolName: string;
  schoolEmail: string | null;
  country: string;
  city: string;
  address: string;
  website: string | null;
  studentCount: number | null;
  currency: string;
  message: string | null;
  proofFileName: string;
  submittedAt: string;
  /** The platform console's page for this application. */
  consoleUrl: string;
}

const PROVIDER_LABELS: Record<string, string> = { google: "Google", microsoft: "Microsoft" };

/** Staff-facing: a school owner submitted a sign-up application with proof of ownership. */
export function renderSchoolApplicationEmail(data: SchoolApplicationEmailData): RenderedEmail {
  const fields: [string, string | null][] = [
    ["School", data.schoolName],
    ["Country", data.country],
    ["City", data.city],
    ["Address", data.address],
    ["School email", data.schoolEmail],
    ["Website", data.website],
    ["Students", data.studentCount === null ? null : String(data.studentCount)],
    ["Currency", data.currency],
    ["Applicant", data.applicantName],
    ["Role", data.applicantJobTitle],
    ["Applicant email", data.applicantEmail],
    ["Phone", data.applicantPhone],
    ["Signed up with", PROVIDER_LABELS[data.provider] ?? data.provider],
    ["Proof of ownership", data.proofFileName],
    ["Received", formatDateLabel(data.submittedAt)],
  ];
  const present = fields.filter((field): field is [string, string] => field[1] !== null);

  const rowsHtml = present
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const messageHtml = data.message
    ? `<p style="margin:16px 0 4px;color:#6b7280">Message</p><p style="margin:0;white-space:pre-wrap">${escapeHtml(data.message)}</p>`
    : "";
  const bodyHtml = `<p>New school sign-up application from <strong>${escapeHtml(data.applicantName)}</strong> for <strong>${escapeHtml(data.schoolName)}</strong>.</p><table role="presentation" cellpadding="0" cellspacing="0">${rowsHtml}</table>${messageHtml}${button(data.consoleUrl, "Review in platform console")}<p>The proof of ownership is attached to the application in the console.</p>`;

  const text = [
    `New school sign-up application from ${data.applicantName} for ${data.schoolName}.`,
    "",
    ...present.map(([label, value]) => `${label}: ${value}`),
    ...(data.message ? ["", "Message:", data.message] : []),
    "",
    `Review it in the platform console: ${data.consoleUrl}`,
  ].join("\n");

  return {
    subject: `New school application: ${data.schoolName} (${data.city}, ${data.country})`,
    text,
    html: shell("Studafy onboarding", bodyHtml),
  };
}

export interface SchoolApplicationDecisionEmailData {
  applicantName: string;
  schoolName: string;
  /** "google" | "microsoft" -- the account they must sign in with. */
  provider: string;
  /** Approved: the sign-in page. Rejected: the sign-up page, to apply again. */
  actionUrl: string;
  /** The reviewer's reason, for a rejection. */
  reason: string | null;
}

/** Applicant-facing: their school was approved and is ready to sign in to. */
export function renderSchoolApplicationApprovedEmail(
  data: SchoolApplicationDecisionEmailData,
): RenderedEmail {
  const provider = PROVIDER_LABELS[data.provider] ?? data.provider;
  const bodyHtml = `<p>Hi ${escapeHtml(data.applicantName)},</p><p>Good news: <strong>${escapeHtml(data.schoolName)}</strong> has been approved and your Studafy school is ready.</p><p>Sign in with the same ${escapeHtml(provider)} account you used to apply. You are the school's administrator and can invite your staff from there.</p>${button(data.actionUrl, "Sign in to Studafy")}`;
  return {
    subject: `${data.schoolName} is approved — welcome to Studafy`,
    text: `Hi ${data.applicantName},\n\nGood news: ${data.schoolName} has been approved and your Studafy school is ready.\n\nSign in with the same ${provider} account you used to apply. You are the school's administrator and can invite your staff from there.\n\nSign in: ${data.actionUrl}`,
    html: shell("Studafy", bodyHtml),
  };
}

/** Applicant-facing: their application was not approved, with the reviewer's reason. */
export function renderSchoolApplicationRejectedEmail(
  data: SchoolApplicationDecisionEmailData,
): RenderedEmail {
  const reasonHtml = data.reason
    ? `<p style="margin:16px 0 4px;color:#6b7280">Reason</p><p style="margin:0;white-space:pre-wrap">${escapeHtml(data.reason)}</p>`
    : "";
  const bodyHtml = `<p>Hi ${escapeHtml(data.applicantName)},</p><p>We reviewed your application for <strong>${escapeHtml(data.schoolName)}</strong> and could not approve it.</p>${reasonHtml}<p>You can submit a new application with updated details or proof of ownership.</p>${button(data.actionUrl, "Apply again")}`;
  return {
    subject: `Your Studafy application for ${data.schoolName}`,
    text: [
      `Hi ${data.applicantName},`,
      "",
      `We reviewed your application for ${data.schoolName} and could not approve it.`,
      ...(data.reason ? ["", `Reason: ${data.reason}`] : []),
      "",
      "You can submit a new application with updated details or proof of ownership.",
      "",
      `Apply again: ${data.actionUrl}`,
    ].join("\n"),
    html: shell("Studafy", bodyHtml),
  };
}

// ---------------------------------------------------------------------------------------------------
// Licence instalment billing emails (000233)
// ---------------------------------------------------------------------------------------------------

export type LicensePaymentEmailKind = "instalment_overdue" | "ai_stop_warning" | "ai_stopped";

export interface LicensePaymentEmailData {
  kind: LicensePaymentEmailKind;
  locale: "en" | "ar";
  schoolName: string;
  invoiceNumber: string;
  instalmentPosition: number;
  instalmentCount: number;
  /** Already formatted with its currency, e.g. "250.00 USD". */
  amount: string;
  /** YYYY-MM-DD. */
  dueDate: string;
  /** YYYY-MM-DD: the day the AI stops (or stopped) while the instalment is unpaid. */
  stopDate: string;
  licenseStartsOn: string;
  licenseEndsOn: string;
  paymentReference: string;
  /** The instalment's online payment link (Revolut), when the super admin has added one. */
  paymentLink: string | null;
  bankDetails: {
    bankName: string;
    accountName: string;
    iban: string;
    swift: string;
    currencyCode: string;
  } | null;
  /** The invoice page in the school portal. */
  invoiceUrl: string;
}

/** The email template recorded in app.email_deliveries for each kind. */
export const LICENSE_PAYMENT_TEMPLATES: Record<LicensePaymentEmailKind, EmailTemplate> = {
  instalment_overdue: "license-instalment-overdue",
  ai_stop_warning: "license-ai-stop-warning",
  ai_stopped: "license-ai-stopped",
};

const MONTHS = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  ar: [
    "يناير",
    "فبراير",
    "مارس",
    "أبريل",
    "مايو",
    "يونيو",
    "يوليو",
    "أغسطس",
    "سبتمبر",
    "أكتوبر",
    "نوفمبر",
    "ديسمبر",
  ],
} as const;

/**
 * "1 March 2027" / "1 مارس 2027": a calendar date (YYYY-MM-DD). Spelled out here rather than with
 * Intl, whose Arabic month names and digits differ between ICU builds (so the same email would read
 * differently on different hosts); Western digits, as the amounts and invoice numbers use.
 */
function calendarDate(day: string, locale: "en" | "ar"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  const month = match ? MONTHS[locale][Number(match[2]) - 1] : undefined;
  if (!match || !month) return day;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

const LICENSE_PAYMENT_COPY = {
  en: {
    subject: {
      instalment_overdue: (d: LicensePaymentEmailData) =>
        `Payment overdue: invoice ${d.invoiceNumber} for ${d.schoolName}'s Studafy licence`,
      ai_stop_warning: (d: LicensePaymentEmailData, stop: string) =>
        `Studafy AI stops on ${stop} unless invoice ${d.invoiceNumber} is paid`,
      ai_stopped: (d: LicensePaymentEmailData) =>
        `Studafy AI has stopped for ${d.schoolName}: invoice ${d.invoiceNumber} is unpaid`,
    },
    lead: {
      instalment_overdue: (d: LicensePaymentEmailData, due: string) =>
        `Payment ${d.instalmentPosition} of ${d.instalmentCount} on invoice ${d.invoiceNumber} was due on ${due}, and ${d.amount} is still unpaid.`,
      ai_stop_warning: (d: LicensePaymentEmailData, due: string) =>
        `Payment ${d.instalmentPosition} of ${d.instalmentCount} on invoice ${d.invoiceNumber} was due on ${due}, and ${d.amount} is still unpaid.`,
      ai_stopped: (d: LicensePaymentEmailData, due: string) =>
        `Payment ${d.instalmentPosition} of ${d.instalmentCount} on invoice ${d.invoiceNumber} was due on ${due}, and ${d.amount} is still unpaid 30 days later.`,
    },
    consequence: {
      instalment_overdue: (stop: string) =>
        `If it is still unpaid on ${stop}, Studafy AI stops for every seat on the licence until it is paid.`,
      ai_stop_warning: (stop: string) =>
        `If it is still unpaid on ${stop}, in a week or less, Studafy AI stops for every seat on the licence until it is paid.`,
      ai_stopped: (stop: string) =>
        `Studafy AI stopped on ${stop}: the students and teachers holding the licence's seats have lost its AI features. They come back as soon as Studafy records the payment.`,
    },
    licence: (school: string, from: string, to: string) => `Licence: ${school}, ${from} to ${to}.`,
    howTitle: "How to pay",
    bank: (b: NonNullable<LicensePaymentEmailData["bankDetails"]>) => [
      `Bank transfer to ${b.accountName}, ${b.bankName}`,
      `IBAN: ${b.iban}`,
      `SWIFT/BIC: ${b.swift}`,
      `Currency: ${b.currencyCode}`,
    ],
    noBank: "Studafy will send you the bank details for the transfer.",
    reference: (ref: string) =>
      `Write the payment reference ${ref} on the transfer, then upload the receipt on the invoice page.`,
    payOnline: "Pay online",
    payOnlineText: (link: string) => `Or pay online: ${link}`,
    viewInvoice: "View the invoice",
    viewInvoiceText: (url: string) => `View the invoice: ${url}`,
    footer: "You receive this email because you manage your school's Studafy licence.",
  },
  ar: {
    subject: {
      instalment_overdue: (d: LicensePaymentEmailData) =>
        `دفعة متأخرة: الفاتورة ${d.invoiceNumber} لترخيص Studafy الخاص بـ ${d.schoolName}`,
      ai_stop_warning: (d: LicensePaymentEmailData, stop: string) =>
        `يتوقف Studafy AI في ${stop} ما لم تُسدَّد الفاتورة ${d.invoiceNumber}`,
      ai_stopped: (d: LicensePaymentEmailData) =>
        `توقف Studafy AI لدى ${d.schoolName}: الفاتورة ${d.invoiceNumber} غير مسددة`,
    },
    lead: {
      instalment_overdue: (d: LicensePaymentEmailData, due: string) =>
        `كانت الدفعة ${d.instalmentPosition} من ${d.instalmentCount} في الفاتورة ${d.invoiceNumber} مستحقة في ${due}، وما زال ${d.amount} غير مسدد.`,
      ai_stop_warning: (d: LicensePaymentEmailData, due: string) =>
        `كانت الدفعة ${d.instalmentPosition} من ${d.instalmentCount} في الفاتورة ${d.invoiceNumber} مستحقة في ${due}، وما زال ${d.amount} غير مسدد.`,
      ai_stopped: (d: LicensePaymentEmailData, due: string) =>
        `كانت الدفعة ${d.instalmentPosition} من ${d.instalmentCount} في الفاتورة ${d.invoiceNumber} مستحقة في ${due}، وما زال ${d.amount} غير مسدد بعد 30 يومًا.`,
    },
    consequence: {
      instalment_overdue: (stop: string) =>
        `إذا بقيت غير مسددة في ${stop}، يتوقف Studafy AI لكل مقاعد الترخيص حتى تُسدَّد.`,
      ai_stop_warning: (stop: string) =>
        `إذا بقيت غير مسددة في ${stop}، أي خلال أسبوع أو أقل، يتوقف Studafy AI لكل مقاعد الترخيص حتى تُسدَّد.`,
      ai_stopped: (stop: string) =>
        `توقف Studafy AI في ${stop}: فقد الطلاب والمعلمون الحاملون لمقاعد الترخيص ميزات الذكاء الاصطناعي، وتعود فور تسجيل Studafy للدفعة.`,
    },
    licence: (school: string, from: string, to: string) =>
      `الترخيص: ${school}، من ${from} إلى ${to}.`,
    howTitle: "طريقة الدفع",
    bank: (b: NonNullable<LicensePaymentEmailData["bankDetails"]>) => [
      `تحويل بنكي إلى ${b.accountName}، ${b.bankName}`,
      `IBAN: ${b.iban}`,
      `SWIFT/BIC: ${b.swift}`,
      `العملة: ${b.currencyCode}`,
    ],
    noBank: "سترسل لكم Studafy بيانات الحساب البنكي للتحويل.",
    reference: (ref: string) =>
      `اكتبوا مرجع الدفع ${ref} على التحويل، ثم ارفعوا الإيصال في صفحة الفاتورة.`,
    payOnline: "ادفعوا عبر الإنترنت",
    payOnlineText: (link: string) => `أو ادفعوا عبر الإنترنت: ${link}`,
    viewInvoice: "عرض الفاتورة",
    viewInvoiceText: (url: string) => `عرض الفاتورة: ${url}`,
    footer: "تصلكم هذه الرسالة لأنكم تديرون ترخيص Studafy الخاص بمدرستكم.",
  },
} as const;

/**
 * A billing email about one licence instalment (000233), in the school's language: what is unpaid
 * and since when, when the AI stops (or that it has), how to pay -- bank transfer with the payment
 * reference, or the instalment's online link -- and a link to the invoice. Never names a student.
 */
export function renderLicensePaymentEmail(data: LicensePaymentEmailData): RenderedEmail {
  const copy = LICENSE_PAYMENT_COPY[data.locale];
  const due = calendarDate(data.dueDate, data.locale);
  const stop = calendarDate(data.stopDate, data.locale);
  const subject = copy.subject[data.kind](data, stop);
  const lead = copy.lead[data.kind](data, due);
  const consequence = copy.consequence[data.kind](stop);
  const licence = copy.licence(
    data.schoolName,
    calendarDate(data.licenseStartsOn, data.locale),
    calendarDate(data.licenseEndsOn, data.locale),
  );
  const bankLines = data.bankDetails ? copy.bank(data.bankDetails) : [copy.noBank];
  const reference = copy.reference(data.paymentReference);

  const text = [
    lead,
    consequence,
    licence,
    "",
    `${copy.howTitle}:`,
    ...bankLines,
    reference,
    ...(data.paymentLink ? [copy.payOnlineText(data.paymentLink)] : []),
    "",
    copy.viewInvoiceText(data.invoiceUrl),
    "",
    copy.footer,
  ].join("\n");

  const dir = data.locale === "ar" ? "rtl" : "ltr";
  const bodyHtml =
    `<div dir="${dir}" style="text-align:${dir === "rtl" ? "right" : "left"}">` +
    `<p>${escapeHtml(lead)}</p>` +
    `<p><strong>${escapeHtml(consequence)}</strong></p>` +
    `<p>${escapeHtml(licence)}</p>` +
    `<p style="margin-bottom:4px"><strong>${escapeHtml(copy.howTitle)}</strong></p>` +
    `<p style="margin-top:0">${bankLines.map(escapeHtml).join("<br>")}</p>` +
    `<p>${escapeHtml(reference)}</p>` +
    (data.paymentLink ? button(data.paymentLink, copy.payOnline) : "") +
    button(data.invoiceUrl, copy.viewInvoice) +
    `<p style="color:#6b7480;font-size:12px">${escapeHtml(copy.footer)}</p>` +
    `</div>`;
  return { subject, text, html: shell(data.schoolName, bodyHtml) };
}
