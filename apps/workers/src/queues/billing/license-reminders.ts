/**
 * License billing reminders (session 3 of docs/billing/feature-licensing.md). Hourly, after the
 * lifecycle job, per school:
 *
 *   license_expiring_30 / license_expiring_7 -- an active license ends within 30 / 7 days
 *   invoice_due                              -- an unpaid instalment falls due today (UTC)
 *   invoice_overdue                          -- an unpaid instalment was marked overdue
 *
 * Invoice reminders are per instalment (000221): each instalment of a monthly or custom plan is
 * reminded of once when due and once when overdue; the subject is the instalment, whose id is the
 * invoice's own for every invoice issued before instalments existed, so nothing is sent twice.
 *   receipt_uploaded                         -- the school uploaded a transfer receipt
 *   ai_stop_warning                          -- an unpaid instalment's AI cutoff (30 days after its
 *                                               due date, 000231) is 7 days away or less
 *   ai_stopped                               -- the licence was suspended for that instalment
 *
 * All but receipt_uploaded go to the school's ORG_ADMINs and PRINCIPALs and to every super admin; a receipt
 * goes to the super admins only (the school uploaded it). They are in-app notifications, rendered
 * from @studafy/notification-templates in the recipient school's language -- the same delivery as
 * session 2's App Store notice.
 *
 * Each reminder is sent once: app.license_reminders is claimed (INSERT ... ON CONFLICT DO NOTHING) in
 * the transaction that writes the notifications, so a re-run, or two workers at once, send nothing
 * twice. A super admin's notification belongs to their own school; it is written in the same
 * transaction by arming that school's scope for the insert and the subject school's again after, so
 * the claim and every notice commit together.
 */

import {
  LICENSE_AI_STOP_WARNING_DAYS,
  LICENSE_NONPAYMENT_GRACE_DAYS,
  NOTIFICATION_TYPES,
  licenseAiStopDate,
} from "@studafy/constants";
import {
  isTemplateLocale,
  NOTIFICATION_CHANNELS,
  renderNotification,
} from "@studafy/notification-templates";

import { withSystemTenantTx } from "../../db/tenant-tx";

import type { BillingLogger } from "@studafy/billing";
import type { NotificationType } from "@studafy/constants";
import type { TemplateLocale } from "@studafy/notification-templates";
import type { Sql, TransactionSql } from "postgres";

const DAY_MS = 86_400_000;

export type LicenseReminderKind =
  | "license_expiring_30"
  | "license_expiring_7"
  | "invoice_due"
  | "invoice_overdue"
  | "receipt_uploaded"
  | "ai_stop_warning"
  | "ai_stopped";

export interface LicenseRemindersResult {
  schools: number;
  reminders: Record<LicenseReminderKind, number>;
  notifications: number;
  failedSchools: number;
}

interface Recipient {
  schoolId: string;
  userId: string;
}

interface Reminder {
  kind: LicenseReminderKind;
  subjectId: string;
  type: NotificationType;
  vars: Record<string, string>;
  /** False for a receipt: the school uploaded it and need not be told. */
  toSchool: boolean;
}

/** Every active SUPER_ADMIN, with their home school. Read school by school (tenant isolation). */
export async function loadSuperAdmins(
  sql: Sql,
  schoolIds: readonly string[],
): Promise<Recipient[]> {
  const admins: Recipient[] = [];
  for (const schoolId of schoolIds) {
    await withSystemTenantTx(sql, { schoolId }, async (tx) => {
      const rows = await tx<{ user_id: string }[]>`
        SELECT DISTINCT ur.user_id::text AS user_id
        FROM app.user_roles AS ur
        JOIN app.users AS u ON u.id = ur.user_id AND u.school_id = ur.school_id
        WHERE ur.school_id = current_setting('app.school_id')::uuid
          AND ur.role = 'SUPER_ADMIN'::app.user_role
          AND u.status = 'active'
      `;
      admins.push(...rows.map((row) => ({ schoolId, userId: row.user_id })));
    });
  }
  return admins;
}

async function schoolAdmins(tx: TransactionSql, schoolId: string): Promise<Recipient[]> {
  const rows = await tx<{ user_id: string }[]>`
    SELECT DISTINCT ur.user_id::text AS user_id
    FROM app.user_roles AS ur
    JOIN app.users AS u ON u.id = ur.user_id AND u.school_id = ur.school_id
    WHERE ur.school_id = current_setting('app.school_id')::uuid
      AND ur.role IN ('ORG_ADMIN'::app.user_role, 'PRINCIPAL'::app.user_role)
      AND u.status = 'active'
  `;
  return rows.map((row) => ({ schoolId, userId: row.user_id }));
}

/** The armed school's language for its notices (users have none of their own). */
async function schoolLocale(tx: TransactionSql): Promise<TemplateLocale> {
  const [settings] = await tx<{ locale: string | null }[]>`
    SELECT locale FROM app.school_settings WHERE school_id = current_setting('app.school_id')::uuid
  `;
  return isTemplateLocale(settings?.locale ?? "") ? (settings!.locale as TemplateLocale) : "en";
}

export function formatMoney(amountMinor: number, minorUnit: number, currencyCode: string): string {
  return `${(amountMinor / 10 ** minorUnit).toFixed(minorUnit)} ${currencyCode}`;
}

/** What is due in the armed school now, whether or not it has been sent. */
async function dueReminders(
  tx: TransactionSql,
  now: Date,
  schoolName: string,
): Promise<Reminder[]> {
  const reminders: Reminder[] = [];
  const in30 = new Date(now.getTime() + 30 * DAY_MS);
  const today = now.toISOString().slice(0, 10);

  const licenses = await tx<{ id: string; ends_at: Date }[]>`
    SELECT id::text AS id, ends_at FROM app.school_licenses
    WHERE school_id = current_setting('app.school_id')::uuid
      AND status = 'active' AND ends_at > ${now} AND ends_at <= ${in30}
  `;
  for (const license of licenses) {
    const daysLeft = Math.ceil((license.ends_at.getTime() - now.getTime()) / DAY_MS);
    reminders.push({
      kind: daysLeft <= 7 ? "license_expiring_7" : "license_expiring_30",
      subjectId: license.id,
      type: NOTIFICATION_TYPES.LICENSE_EXPIRING,
      vars: {
        schoolName,
        endsAt: license.ends_at.toISOString().slice(0, 10),
        daysLeft: String(daysLeft),
      },
      toSchool: true,
    });
  }

  // Every unpaid instalment of an open invoice that falls due today or has been marked overdue.
  const instalments = await tx<
    {
      id: string;
      number: string;
      due_date: string;
      balance_minor: string;
      overdue_at: Date | null;
      currency_code: string;
      minor_unit: number;
    }[]
  >`
    SELECT inst.id::text AS id, i.number, inst.due_date::text AS due_date,
           inst.balance_minor::text AS balance_minor, inst.overdue_at, c.code AS currency_code,
           c.minor_unit::int AS minor_unit
    FROM app.license_invoice_instalments AS inst
    JOIN app.license_invoices AS i ON i.id = inst.invoice_id AND i.school_id = inst.school_id
    JOIN app.currencies AS c ON c.id = i.currency_id
    WHERE inst.school_id = current_setting('app.school_id')::uuid
      AND i.status IN ('issued', 'partially_paid')
      AND inst.status <> 'paid'
      AND (inst.overdue_at IS NOT NULL OR inst.due_date = ${today}::date)
    ORDER BY i.number, inst.position
  `;
  for (const instalment of instalments) {
    reminders.push({
      kind: instalment.overdue_at ? "invoice_overdue" : "invoice_due",
      subjectId: instalment.id,
      type: instalment.overdue_at
        ? NOTIFICATION_TYPES.LICENSE_INVOICE_OVERDUE
        : NOTIFICATION_TYPES.LICENSE_INVOICE_DUE,
      vars: {
        schoolName,
        invoiceNumber: instalment.number,
        balance: formatMoney(
          Number(instalment.balance_minor),
          instalment.minor_unit,
          instalment.currency_code,
        ),
        dueDate: instalment.due_date,
      },
      toSchool: true,
    });
  }

  // The AI cutoff of every unpaid instalment on a licence in force: warned of once it is a week or
  // less away; told once the licence is stopped for it (the earliest such instalment per licence, so
  // a later instalment stopping it again is told again).
  const cutoffs = await tx<
    {
      id: string;
      number: string;
      due_date: string;
      balance_minor: string;
      currency_code: string;
      minor_unit: number;
      license_status: string;
      stopped: boolean;
      first_late: boolean;
    }[]
  >`
    SELECT inst.id::text AS id, i.number, inst.due_date::text AS due_date,
           inst.balance_minor::text AS balance_minor, c.code AS currency_code,
           c.minor_unit::int AS minor_unit, l.status AS license_status,
           (l.nonpayment_suspended_at IS NOT NULL) AS stopped,
           inst.id = first_value(inst.id) OVER (
             PARTITION BY l.id ORDER BY inst.due_date, i.number, inst.position
           ) AS first_late
    FROM app.license_invoice_instalments AS inst
    JOIN app.license_invoices AS i ON i.id = inst.invoice_id AND i.school_id = inst.school_id
    JOIN app.school_licenses AS l ON l.id = i.license_id AND l.school_id = i.school_id
    JOIN app.currencies AS c ON c.id = i.currency_id
    WHERE inst.school_id = current_setting('app.school_id')::uuid
      AND i.status IN ('issued', 'partially_paid')
      AND inst.status <> 'paid'
      AND l.status IN ('active', 'suspended')
      AND inst.due_date + ${LICENSE_NONPAYMENT_GRACE_DAYS}::int
          <= ${today}::date + ${LICENSE_AI_STOP_WARNING_DAYS}::int
    ORDER BY i.number, inst.position
  `;
  for (const instalment of cutoffs) {
    const stopDate = licenseAiStopDate(instalment.due_date);
    const vars = {
      schoolName,
      invoiceNumber: instalment.number,
      balance: formatMoney(
        Number(instalment.balance_minor),
        instalment.minor_unit,
        instalment.currency_code,
      ),
      dueDate: instalment.due_date,
      stopDate,
    };
    if (instalment.stopped && instalment.first_late && stopDate <= today) {
      reminders.push({
        kind: "ai_stopped",
        subjectId: instalment.id,
        type: NOTIFICATION_TYPES.LICENSE_AI_STOPPED,
        vars,
        toSchool: true,
      });
    } else if (instalment.license_status === "active" && stopDate > today) {
      reminders.push({
        kind: "ai_stop_warning",
        subjectId: instalment.id,
        type: NOTIFICATION_TYPES.LICENSE_AI_STOP_WARNING,
        vars: {
          ...vars,
          daysLeft: String(
            Math.round(
              (Date.parse(`${stopDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
            ),
          ),
        },
        toSchool: true,
      });
    }
  }

  const receipts = await tx<{ id: string; number: string }[]>`
    SELECT r.id::text AS id, i.number
    FROM app.license_payment_receipts AS r
    JOIN app.license_invoices AS i ON i.id = r.invoice_id AND i.school_id = r.school_id
    WHERE r.school_id = current_setting('app.school_id')::uuid AND r.status = 'pending'
  `;
  for (const receipt of receipts) {
    reminders.push({
      kind: "receipt_uploaded",
      subjectId: receipt.id,
      type: NOTIFICATION_TYPES.LICENSE_RECEIPT_UPLOADED,
      vars: { schoolName, invoiceNumber: receipt.number },
      toSchool: false,
    });
  }
  return reminders;
}

/** One in-app notification in the armed school. The id is minted here (owner-only SELECT policy). */
async function notify(
  tx: TransactionSql,
  recipient: Recipient,
  reminder: Reminder,
  subjectSchoolId: string,
): Promise<void> {
  const locale = await schoolLocale(tx);
  await tx`
    INSERT INTO app.notifications (id, school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${crypto.randomUUID()}::uuid,
      ${recipient.schoolId}::uuid,
      ${recipient.userId}::uuid,
      ${reminder.type}::app.notification_type,
      ${renderNotification(reminder.type as never, NOTIFICATION_CHANNELS.PUSH, locale, reminder.vars).trim()},
      ${renderNotification(reminder.type as never, NOTIFICATION_CHANNELS.IN_APP, locale, reminder.vars).trim()},
      ${tx.json({ kind: reminder.kind, school_id: subjectSchoolId, subject_id: reminder.subjectId })}
    )
  `;
}

export async function runLicenseReminders(
  sql: Sql,
  now: Date,
  log: BillingLogger,
  schoolIds?: readonly string[],
): Promise<LicenseRemindersResult> {
  const allSchools = await sql<{ id: string; name: string }[]>`
    SELECT id::text AS id, name FROM app.schools ORDER BY id
  `;
  const schools = schoolIds ? allSchools.filter((s) => schoolIds.includes(s.id)) : allSchools;
  const superAdmins = await loadSuperAdmins(
    sql,
    allSchools.map((s) => s.id),
  );

  const result: LicenseRemindersResult = {
    schools: schools.length,
    reminders: {
      license_expiring_30: 0,
      license_expiring_7: 0,
      invoice_due: 0,
      invoice_overdue: 0,
      receipt_uploaded: 0,
      ai_stop_warning: 0,
      ai_stopped: 0,
    },
    notifications: 0,
    failedSchools: 0,
  };

  for (const school of schools) {
    try {
      await withSystemTenantTx(sql, { schoolId: school.id }, async (tx) => {
        const admins = await schoolAdmins(tx, school.id);
        for (const reminder of await dueReminders(tx, now, school.name)) {
          const [claimed] = await tx<{ kind: string }[]>`
            INSERT INTO app.license_reminders (school_id, kind, subject_id, recipients)
            VALUES (current_setting('app.school_id')::uuid, ${reminder.kind}, ${reminder.subjectId}::uuid, 0)
            ON CONFLICT ON CONSTRAINT pk_license_reminders DO NOTHING
            RETURNING kind
          `;
          if (!claimed) continue;

          const recipients = [...(reminder.toSchool ? admins : []), ...superAdmins];
          for (const recipient of recipients) {
            if (recipient.schoolId !== school.id) {
              await tx`SELECT set_config('app.school_id', ${recipient.schoolId}, true)`;
            }
            await notify(tx, recipient, reminder, school.id);
            if (recipient.schoolId !== school.id) {
              await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
            }
          }
          await tx`
            UPDATE app.license_reminders SET recipients = ${recipients.length}
            WHERE school_id = current_setting('app.school_id')::uuid
              AND kind = ${reminder.kind} AND subject_id = ${reminder.subjectId}::uuid
          `;
          result.reminders[reminder.kind] += 1;
          result.notifications += recipients.length;
        }
      });
    } catch (err) {
      result.failedSchools += 1;
      log.warn({ err, school_id: school.id }, "license reminders failed for school");
    }
  }

  log.info({ ...result }, "license reminders complete");
  return result;
}
