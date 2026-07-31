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

export type EmailTemplate = "invitation" | "verification" | "dunning" | "digest" | "alert";

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

export interface AlertEmailData {
  schoolName: string;
  studentName: string;
  body: string;
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
