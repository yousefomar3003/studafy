/**
 * Email templates for the transactional channel (deliverability R-08).
 *
 * Every template is a pure function of plain data: given a school name, a link, and the payload
 * fields it needs, it returns a fully-rendered { subject, text, html }. There is no template
 * engine and no I/O — the dispatcher renders inline before handing the message to the SES sender,
 * and unit tests exercise each template without a database.
 *
 * All copy is English-only (a localization pass is a separate concern, not this ticket).
 */

export type EmailTemplate =
  | "invitation"
  | "verification"
  | "dunning"
  | "digest"
  | "alert"
  | "seat-drift"
  | "ai-subscription-paused"
  | "ai-subscription-resumed";

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

export interface AlertEmailData {
  schoolName: string;
  studentName: string;
  body: string;
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

export interface DigestItem {
  kind: "attendance_alert" | "fee_overdue";
  studentName: string | null;
  text: string;
  /** ISO datetime the underlying event occurred. */
  occurredAt: string;
}

export interface DigestEmailData {
  schoolName: string;
  digestDate: string;
  items: DigestItem[];
}

/**
 * One aggregated line in a recipient's daily notification digest (notification.digestSent).
 * title/body are the notification's own rendered text, carried through unchanged rather than
 * reformatted per kind — see notification-digest-producer.ts.
 */
export interface NotificationDigestItem {
  title: string;
  body: string;
  /** ISO datetime the underlying notification was created. */
  occurredAt: string;
}

export interface NotificationDigestEmailData {
  schoolName: string;
  digestDate: string;
  items: NotificationDigestItem[];
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

function shell(schoolName: string, bodyHtml: string): string {
  const safeSchool = escapeHtml(schoolName);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:24px 0"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden"><tr><td style="padding:24px 32px;border-bottom:1px solid #e6e8eb"><p style="margin:0;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;color:#1a2332">${safeSchool}</p></td></tr><tr><td style="padding:32px;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333c47">${bodyHtml}</td></tr></table></td></tr></table>`;
}

function button(actionUrl: string, label: string): string {
  const safeUrl = escapeHtml(actionUrl);
  return `<p style="margin:24px 0"><a href="${safeUrl}" style="display:inline-block;padding:10px 20px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold">${escapeHtml(label)}</a></p>`;
}

function formatDateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toUTCString();
}

export function renderInvitationEmail(data: InvitationEmailData): RenderedEmail {
  const bodyHtml = `<p>You have been invited to join ${escapeHtml(data.schoolName)} on Studafy.</p>${button(data.actionUrl, "Accept invitation")}<p>If the button does not work, open this link in your browser: <a href="${escapeHtml(data.actionUrl)}">${escapeHtml(data.actionUrl)}</a></p>${data.expiresAt ? `<p>This invitation expires on ${formatDateLabel(data.expiresAt)}.</p>` : ""}`;
  return {
    subject: `You're invited to ${data.schoolName}`,
    text: `You have been invited to join ${data.schoolName} on Studafy.\n\nAccept your invitation here: ${data.actionUrl}\n${data.expiresAt ? `\nThis invitation expires on ${formatDateLabel(data.expiresAt)}.` : ""}`,
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

export function renderNotificationDigestEmail(data: NotificationDigestEmailData): RenderedEmail {
  const itemsHtml = data.items
    .map(
      (item) =>
        `<li style="margin-bottom:12px"><strong>${escapeHtml(item.title)}</strong> — ${escapeHtml(item.body)}<br><span style="font-size:12px;color:#6b7280">${formatDateLabel(item.occurredAt)}</span></li>`,
    )
    .join("");
  const countLabel = data.items.length === 1 ? "1 update" : `${data.items.length} updates`;
  const bodyHtml = `<p>Here is your daily digest from ${escapeHtml(data.schoolName)}.</p><ul style="margin:16px 0;padding-left:20px">${itemsHtml}</ul><p>Log in to Studafy for details.</p>`;
  return {
    subject: `Your daily digest from ${data.schoolName} (${countLabel})`,
    text: `Here is your daily digest from ${data.schoolName}.\n\n${data.items
      .map((item) => `- ${item.title}: ${item.body} (${formatDateLabel(item.occurredAt)})`)
      .join("\n")}\n\nLog in to Studafy for details.`,
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

export function renderAlertEmail(data: AlertEmailData): RenderedEmail {
  const bodyHtml = `<p>${escapeHtml(data.body)}</p>`;
  return {
    subject: `Alert for ${data.studentName}`,
    text: data.body,
    html: shell(data.schoolName, bodyHtml),
  };
}

export function renderDigestEmail(data: DigestEmailData): RenderedEmail {
  const itemsHtml = data.items
    .map((item) => {
      const name = item.studentName ? escapeHtml(item.studentName) : "Your child";
      return `<li style="margin-bottom:12px"><strong>${name}</strong> — ${escapeHtml(item.text)}<br><span style="font-size:12px;color:#6b7280">${formatDateLabel(item.occurredAt)}</span></li>`;
    })
    .join("");
  const countLabel = data.items.length === 1 ? "1 update" : `${data.items.length} updates`;
  const bodyHtml = `<p>Here is a summary of the latest updates from ${escapeHtml(data.schoolName)}.</p><ul style="margin:16px 0;padding-left:20px">${itemsHtml}</ul><p>Log in to Studafy for details.</p>`;
  return {
    subject: `Daily digest from ${data.schoolName} (${countLabel})`,
    text: `Here is a summary of the latest updates from ${data.schoolName}.\n\n${data.items
      .map(
        (item) =>
          `- ${item.studentName ? item.studentName : "Your child"}: ${item.text} (${formatDateLabel(item.occurredAt)})`,
      )
      .join("\n")}\n\nLog in to Studafy for details.`,
    html: shell(data.schoolName, bodyHtml),
  };
}
