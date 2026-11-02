/**
 * Fee notices to guardians (000152, 000153).
 *
 * Four messages, two triggers:
 *
 *   * invoice_issued / payment_received -- automatic, from ERPNext's Sales Invoice and Payment Entry
 *     webhooks, once the document is in the finance cache. One per document per guardian: the
 *     partial unique index on app.finance_communications decides, so a redelivered webhook or a
 *     payment confirmed twice (webhook, then reconciliation) never notifies twice.
 *   * payment_reminder / statement -- sent by finance for a whole family, from its page or in bulk.
 *     A reminder is refused within REMINDER_COOLDOWN_HOURS of the last one, so a bulk run after a
 *     single send does not reach the same family twice in a day.
 *
 * Every function here runs in a transaction the caller opened as `studafy_admin` with the tenant
 * scope set (withStudentIdentityTx): the guardians, their notification preferences and their
 * children are rows FINANCE cannot read and notifications are rows it cannot write for someone
 * else. Tenant isolation still holds, and nothing here returns those rows to the caller beyond
 * names and counts.
 *
 * A guardian who has turned the type off on the in_app channel gets no notification, but the
 * attempt is still logged with delivered = false, so finance sees "turned off" rather than silence.
 */

import { NOTIFICATION_TYPES } from "@studafy/constants";
import {
  isTemplateLocale,
  NOTIFICATION_CHANNELS,
  renderNotification,
} from "@studafy/notification-templates";

import { formatMinorUnits } from "../currency";

import type { NotificationType } from "@studafy/constants";
import type { TransactionSql } from "postgres";

export type FinanceCommunicationKind =
  "invoice_issued" | "payment_received" | "payment_reminder" | "statement";

const TYPE_FOR: Record<FinanceCommunicationKind, NotificationType> = {
  invoice_issued: NOTIFICATION_TYPES.FEE_INVOICE_ISSUED,
  payment_received: NOTIFICATION_TYPES.FEE_PAYMENT_RECEIVED,
  payment_reminder: NOTIFICATION_TYPES.FEE_PAYMENT_REMINDER,
  statement: NOTIFICATION_TYPES.FEE_STATEMENT,
};

/** A second reminder to the same family inside this window is refused. */
export const REMINDER_COOLDOWN_HOURS = 24;

interface Guardian {
  user_id: string;
  family_id: string;
  locale: string | null;
  in_app_enabled: boolean;
}

/**
 * The active guardians linked to the given students or family, one row per guardian and family,
 * with the locale and the in_app preference for `type`.
 */
async function guardians(
  tx: TransactionSql,
  schoolId: string,
  scope: { studentId: string } | { familyId: string },
  type: NotificationType,
): Promise<Guardian[]> {
  const filter =
    "studentId" in scope
      ? tx`AND link.student_id = ${scope.studentId}::uuid`
      : tx`AND link.family_id = ${scope.familyId}::uuid`;
  return tx<Guardian[]>`
    SELECT DISTINCT ON (link.parent_user_id, link.family_id)
           link.parent_user_id AS user_id,
           link.family_id,
           coalesce(settings.locale, school_settings.locale) AS locale,
           NOT EXISTS (
             SELECT 1
             FROM app.notification_preferences AS pref
             WHERE pref.school_id = link.school_id
               AND pref.user_id = link.parent_user_id
               AND pref.notification_type = ${type}::app.notification_type
               AND pref.channel = 'in_app'
               AND pref.enabled = false
           ) AS in_app_enabled
    FROM app.parent_child_links AS link
    JOIN app.users AS guardian
      ON guardian.id = link.parent_user_id AND guardian.school_id = link.school_id
    LEFT JOIN app.user_notification_settings AS settings
      ON settings.user_id = guardian.id AND settings.school_id = guardian.school_id
    LEFT JOIN app.school_settings AS school_settings
      ON school_settings.school_id = guardian.school_id
    WHERE link.school_id = ${schoolId}::uuid
      AND guardian.status = 'active'
      ${filter}
    ORDER BY link.parent_user_id, link.family_id
  `;
}

interface SendParams {
  kind: FinanceCommunicationKind;
  familyId: string | null;
  studentId: string | null;
  reference: string | null;
  sentBy: string | null;
  /** Template variables in the guardian's locale. */
  vars: (locale: "en" | "ar") => Record<string, string>;
  metadata: Record<string, string | null>;
}

/**
 * Logs and (when the guardian allows it) delivers one message to one guardian. Returns null when
 * the log already holds this document notice for them, which is how a duplicate is dropped.
 */
async function sendOne(
  tx: TransactionSql,
  schoolId: string,
  guardian: Guardian,
  params: SendParams,
): Promise<{ delivered: boolean } | null> {
  const type = TYPE_FOR[params.kind];
  const locale = isTemplateLocale(guardian.locale) ? guardian.locale : "en";
  const notificationId = guardian.in_app_enabled ? crypto.randomUUID() : null;
  const documentNotice = params.kind === "invoice_issued" || params.kind === "payment_received";

  const conflict = documentNotice
    ? tx`ON CONFLICT (school_id, kind, reference, recipient_user_id)
         WHERE kind IN ('invoice_issued', 'payment_received') DO NOTHING`
    : tx``;
  const logged = await tx<{ id: string }[]>`
    INSERT INTO app.finance_communications (
      school_id, kind, family_id, student_id, reference, recipient_user_id,
      delivered, notification_id, sent_by
    ) VALUES (
      ${schoolId}::uuid, ${params.kind}, ${params.familyId ?? guardian.family_id}::uuid,
      ${params.studentId}::uuid, ${params.reference}, ${guardian.user_id}::uuid,
      ${notificationId !== null}, ${notificationId}::uuid, ${params.sentBy}::uuid
    )
    ${conflict}
    RETURNING id
  `;
  if (logged.length === 0) return null;
  if (notificationId === null) return { delivered: false };

  const vars = params.vars(locale);
  const title = renderNotification(type, NOTIFICATION_CHANNELS.IN_APP, locale, vars).trim();
  const body = renderNotification(type, NOTIFICATION_CHANNELS.EMAIL, locale, vars).trim();
  // No RETURNING: app.notifications' SELECT policy is owner-only (see messaging/service.ts).
  await tx`
    INSERT INTO app.notifications (id, school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${notificationId}::uuid, ${schoolId}::uuid, ${guardian.user_id}::uuid,
      ${type}::app.notification_type, ${title}, ${body},
      ${tx.json({ ...params.metadata, route: "/" })}
    )
  `;
  return { delivered: true };
}

export interface FamilySendResult {
  /** Guardians who received the notification. */
  delivered: number;
  /** Guardians who have this notification type turned off. */
  suppressed: number;
}

async function sendToGuardians(
  tx: TransactionSql,
  schoolId: string,
  recipients: Guardian[],
  params: SendParams,
): Promise<FamilySendResult> {
  const result: FamilySendResult = { delivered: 0, suppressed: 0 };
  // A guardian linked to the child through two families gets one notice, not two.
  const seen = new Set<string>();
  for (const guardian of recipients) {
    if (seen.has(guardian.user_id)) continue;
    seen.add(guardian.user_id);
    const sent = await sendOne(tx, schoolId, guardian, params);
    if (sent?.delivered) result.delivered += 1;
    else if (sent) result.suppressed += 1;
  }
  return result;
}

function money(minor: bigint, minorUnit: number, currency: string): string {
  return `${formatMinorUnits(minor, minorUnit)} ${currency}`;
}

async function studentName(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
): Promise<string> {
  const [row] = await tx<{ name: string }[]>`
    SELECT coalesce(preferred_name, first_name) || ' ' || last_name AS name
    FROM app.students
    WHERE school_id = ${schoolId}::uuid AND id = ${studentId}::uuid
  `;
  return row?.name ?? "";
}

/**
 * "A new invoice was issued", for a submitted Sales Invoice already in invoice_cache. Credit notes,
 * drafts, cancelled and fully paid invoices are not announced.
 */
export async function notifyInvoiceIssued(
  tx: TransactionSql,
  schoolId: string,
  docname: string,
): Promise<FamilySendResult | null> {
  const [invoice] = await tx<
    {
      student_id: string;
      erpnext_status: string;
      total_amount_minor: string;
      outstanding_amount_minor: string;
      due_date: string | null;
      currency: string;
      minor_unit: number;
    }[]
  >`
    SELECT ic.student_id, ic.erpnext_status, ic.total_amount_minor::text,
           ic.outstanding_amount_minor::text, ic.due_date::text AS due_date,
           c.code AS currency, c.minor_unit
    FROM app.invoice_cache AS ic
    JOIN app.currencies AS c ON c.id = ic.currency_id
    WHERE ic.school_id = ${schoolId}::uuid AND ic.erpnext_docname = ${docname}
  `;
  if (!invoice) return null;
  const status = invoice.erpnext_status.toLowerCase();
  const total = BigInt(invoice.total_amount_minor);
  if (["draft", "cancelled", "return", "credit note issued"].includes(status) || total <= 0n) {
    return null;
  }
  if (BigInt(invoice.outstanding_amount_minor) <= 0n) return null;

  const name = await studentName(tx, schoolId, invoice.student_id);
  const amount = money(total, invoice.minor_unit, invoice.currency);
  return sendToGuardians(
    tx,
    schoolId,
    await guardians(
      tx,
      schoolId,
      { studentId: invoice.student_id },
      NOTIFICATION_TYPES.FEE_INVOICE_ISSUED,
    ),
    {
      kind: "invoice_issued",
      familyId: null,
      studentId: invoice.student_id,
      reference: docname,
      sentBy: null,
      vars: () => ({ studentName: name, amount, dueDate: invoice.due_date ?? "—" }),
      metadata: { student_id: invoice.student_id, invoice_id: docname },
    },
  );
}

/** "We received your payment", for a confirmed Payment Entry already in payment_cache. */
export async function notifyPaymentReceived(
  tx: TransactionSql,
  schoolId: string,
  docname: string,
): Promise<FamilySendResult | null> {
  const [payment] = await tx<
    {
      id: string;
      student_id: string;
      status: string;
      amount_minor: string;
      currency: string;
      minor_unit: number;
    }[]
  >`
    SELECT pc.id, pc.student_id, pc.status, pc.amount_minor::text, c.code AS currency, c.minor_unit
    FROM app.payment_cache AS pc
    JOIN app.currencies AS c ON c.id = pc.currency_id
    WHERE pc.school_id = ${schoolId}::uuid AND pc.erpnext_docname = ${docname}
  `;
  if (!payment || payment.status !== "confirmed") return null;

  const name = await studentName(tx, schoolId, payment.student_id);
  const amount = money(BigInt(payment.amount_minor), payment.minor_unit, payment.currency);
  return sendToGuardians(
    tx,
    schoolId,
    await guardians(
      tx,
      schoolId,
      { studentId: payment.student_id },
      NOTIFICATION_TYPES.FEE_PAYMENT_RECEIVED,
    ),
    {
      kind: "payment_received",
      familyId: null,
      studentId: payment.student_id,
      reference: docname,
      sentBy: null,
      vars: () => ({ studentName: name, amount, receiptNumber: docname }),
      metadata: { student_id: payment.student_id, payment_id: payment.id },
    },
  );
}

/** Formatted per-currency amounts, joined: "1950.000 JOD + 50.00 AED". */
export function formatTotals(
  totals: readonly { currency: string; minorUnit: number; minor: bigint }[],
): string {
  const nonZero = totals.filter((total) => total.minor > 0n);
  if (nonZero.length === 0) return "0";
  return nonZero.map((total) => money(total.minor, total.minorUnit, total.currency)).join(" + ");
}

export interface FamilyBalance {
  displayName: string;
  childCount: number;
  outstanding: { currency: string; minorUnit: number; minor: bigint }[];
  overdue: { currency: string; minorUnit: number; minor: bigint }[];
  overdueInvoiceCount: number;
}

/** A family's name, children and balances from the invoice cache. Null when the family is unknown. */
export async function familyBalance(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
): Promise<FamilyBalance | null> {
  const [family] = await tx<{ display_name: string; child_count: number }[]>`
    SELECT family.display_name,
           (SELECT count(DISTINCT link.student_id)::int
            FROM app.parent_child_links AS link
            WHERE link.school_id = family.school_id AND link.family_id = family.id) AS child_count
    FROM app.families AS family
    WHERE family.school_id = ${schoolId}::uuid AND family.id = ${familyId}::uuid
  `;
  if (!family) return null;

  const rows = await tx<
    {
      currency: string;
      minor_unit: number;
      outstanding: string;
      overdue: string;
      overdue_count: number;
    }[]
  >`
    SELECT c.code AS currency, c.minor_unit,
           coalesce(sum(ic.outstanding_amount_minor), 0)::text AS outstanding,
           coalesce(sum(ic.outstanding_amount_minor)
             FILTER (WHERE ic.due_date < CURRENT_DATE), 0)::text AS overdue,
           (count(*) FILTER (
             WHERE ic.due_date < CURRENT_DATE AND ic.outstanding_amount_minor > 0))::int
             AS overdue_count
    FROM app.invoice_cache AS ic
    JOIN app.currencies AS c ON c.id = ic.currency_id
    WHERE ic.school_id = ${schoolId}::uuid
      AND lower(ic.erpnext_status) NOT IN ('draft', 'cancelled')
      AND ic.outstanding_amount_minor > 0
      AND ic.student_id IN (
        SELECT link.student_id FROM app.parent_child_links AS link
        WHERE link.school_id = ${schoolId}::uuid AND link.family_id = ${familyId}::uuid
      )
    GROUP BY c.code, c.minor_unit
    ORDER BY c.code
  `;

  return {
    displayName: family.display_name,
    childCount: family.child_count,
    outstanding: rows.map((row) => ({
      currency: row.currency,
      minorUnit: row.minor_unit,
      minor: BigInt(row.outstanding),
    })),
    overdue: rows.map((row) => ({
      currency: row.currency,
      minorUnit: row.minor_unit,
      minor: BigInt(row.overdue),
    })),
    overdueInvoiceCount: rows.reduce((sum, row) => sum + row.overdue_count, 0),
  };
}

/** When the family was last reminded, or null. */
export async function lastReminderAt(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
): Promise<Date | null> {
  const [row] = await tx<{ created_at: Date }[]>`
    SELECT created_at
    FROM app.finance_communications
    WHERE school_id = ${schoolId}::uuid
      AND family_id = ${familyId}::uuid
      AND kind = 'payment_reminder'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row?.created_at ?? null;
}

export type ReminderOutcome =
  | { status: "sent"; result: FamilySendResult }
  | { status: "nothing_overdue" }
  | { status: "recently_reminded"; lastReminderAt: Date }
  | { status: "no_guardians" };

/**
 * Remind a family's guardians of its overdue balance. Refused (not thrown) when nothing is overdue,
 * the family was reminded within the cooldown, or it has no active guardian, so a bulk run can
 * report each family's outcome.
 */
export async function sendFamilyReminder(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  sentBy: string,
): Promise<ReminderOutcome | null> {
  const balance = await familyBalance(tx, schoolId, familyId);
  if (!balance) return null;
  if (balance.overdueInvoiceCount === 0) return { status: "nothing_overdue" };

  const last = await lastReminderAt(tx, schoolId, familyId);
  if (last && Date.now() - last.getTime() < REMINDER_COOLDOWN_HOURS * 3_600_000) {
    return { status: "recently_reminded", lastReminderAt: last };
  }

  const recipients = await guardians(
    tx,
    schoolId,
    { familyId },
    NOTIFICATION_TYPES.FEE_PAYMENT_REMINDER,
  );
  if (recipients.length === 0) return { status: "no_guardians" };

  const amount = formatTotals(balance.overdue);
  const result = await sendToGuardians(tx, schoolId, recipients, {
    kind: "payment_reminder",
    familyId,
    studentId: null,
    reference: null,
    sentBy,
    vars: () => ({
      familyName: balance.displayName,
      amount,
      overdueCount: String(balance.overdueInvoiceCount),
    }),
    metadata: { family_id: familyId },
  });
  return { status: "sent", result };
}

export type StatementOutcome =
  { status: "sent"; result: FamilySendResult } | { status: "no_guardians" };

/** Send a family's guardians their fee statement: children, and the outstanding balance. */
export async function sendFamilyStatement(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  sentBy: string,
): Promise<StatementOutcome | null> {
  const balance = await familyBalance(tx, schoolId, familyId);
  if (!balance) return null;

  const recipients = await guardians(tx, schoolId, { familyId }, NOTIFICATION_TYPES.FEE_STATEMENT);
  if (recipients.length === 0) return { status: "no_guardians" };

  const outstanding = formatTotals(balance.outstanding);
  const result = await sendToGuardians(tx, schoolId, recipients, {
    kind: "statement",
    familyId,
    studentId: null,
    reference: null,
    sentBy,
    vars: () => ({
      familyName: balance.displayName,
      outstanding,
      childCount: String(balance.childCount),
    }),
    metadata: { family_id: familyId },
  });
  return { status: "sent", result };
}

export interface CommunicationRow {
  id: string;
  kind: FinanceCommunicationKind;
  student_id: string | null;
  reference: string | null;
  recipient_user_id: string;
  recipient_name: string;
  delivered: boolean;
  sent_by: string | null;
  sent_by_name: string | null;
  created_at: string;
}

/** A family's message history, newest first: its own sends and its children's document notices. */
export async function listFamilyCommunications(
  tx: TransactionSql,
  schoolId: string,
  familyId: string,
  limit: number,
): Promise<CommunicationRow[]> {
  const rows = await tx<(Omit<CommunicationRow, "created_at"> & { created_at: Date })[]>`
    SELECT comm.id, comm.kind, comm.student_id, comm.reference, comm.recipient_user_id,
           coalesce(recipient.display_name, recipient.email) AS recipient_name,
           comm.delivered, comm.sent_by,
           coalesce(sender.display_name, sender.email) AS sent_by_name,
           comm.created_at
    FROM app.finance_communications AS comm
    JOIN app.users AS recipient
      ON recipient.id = comm.recipient_user_id AND recipient.school_id = comm.school_id
    LEFT JOIN app.users AS sender
      ON sender.id = comm.sent_by AND sender.school_id = comm.school_id
    WHERE comm.school_id = ${schoolId}::uuid
      AND (
        comm.family_id = ${familyId}::uuid
        OR comm.student_id IN (
          SELECT link.student_id FROM app.parent_child_links AS link
          WHERE link.school_id = ${schoolId}::uuid AND link.family_id = ${familyId}::uuid
        )
      )
    ORDER BY comm.created_at DESC, comm.id
    LIMIT ${limit}
  `;
  return rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
}
