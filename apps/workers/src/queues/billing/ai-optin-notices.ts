/**
 * Student AI opt-in notices (phase 2 of the Student AI programme, migration 000235,
 * docs/billing/ai-programme.md). Hourly, per school, in its own system tenant transaction:
 *
 *   AI_OPTIN_AVAILABLE -- while a window is open (school-local dates), each eligible child without an
 *                         opt-in: "Student AI is available for <child>" to each linked parent, once
 *                         per child and window (app.ai_optin_window_notices is claimed in the same
 *                         transaction, so a re-run or two workers send nothing twice).
 *   AI_OPTIN_SUMMARY   -- once a day (the run in SUMMARY_HOUR_UTC): to the school's ORG_ADMINs and
 *                         PRINCIPALs, how many opt-ins arrived since the last summary, how many are
 *                         active and how many wait for a seat. The opt-ins it counted are marked
 *                         (ai_optins.admins_notified_at), so each is in one summary.
 *
 * In-app rows only; the push consumer sends them, with push preferences and quiet hours. Never
 * emailed (notifications are in-app and push only). Rendered from @studafy/notification-templates in
 * the school's language. The confirmation a parent gets after opting in is written by the API.
 */

import { NOTIFICATION_TYPES } from "@studafy/constants";
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

/** The hour (UTC) whose run sends leadership's daily summary. */
export const AI_OPTIN_SUMMARY_HOUR_UTC = 16;

export interface AiOptInNoticesResult {
  schools: number;
  /** Children newly told Student AI is available, and the parent notifications that took. */
  children: number;
  parentNotifications: number;
  summaries: number;
  failedSchools: number;
}

async function schoolLocale(tx: TransactionSql): Promise<TemplateLocale> {
  const [settings] = await tx<{ locale: string | null }[]>`
    SELECT locale FROM app.school_settings WHERE school_id = current_setting('app.school_id')::uuid
  `;
  return isTemplateLocale(settings?.locale ?? "") ? (settings!.locale as TemplateLocale) : "en";
}

async function notify(
  tx: TransactionSql,
  userId: string,
  type: NotificationType,
  locale: TemplateLocale,
  vars: Record<string, string>,
  metadata: Record<string, string>,
): Promise<void> {
  await tx`
    INSERT INTO app.notifications (id, school_id, user_id, notification_type, title, body, metadata)
    VALUES (
      ${crypto.randomUUID()}::uuid, current_setting('app.school_id')::uuid, ${userId}::uuid,
      ${type}::app.notification_type,
      ${renderNotification(type as never, NOTIFICATION_CHANNELS.PUSH, locale, vars).trim()},
      ${renderNotification(type as never, NOTIFICATION_CHANNELS.IN_APP, locale, vars).trim()},
      ${tx.json(metadata)}
    )
  `;
}

function money(amountMinor: number, minorUnit: number, currencyCode: string): string {
  return `${(amountMinor / 10 ** minorUnit).toFixed(minorUnit)} ${currencyCode}`;
}

/** The armed school's open window today (school-local), with the price parents see, or null. */
async function openWindow(tx: TransactionSql, now: Date) {
  const [row] = await tx<
    {
      id: string;
      academic_year_id: string;
      closes_on: string;
      price_minor: string | null;
      currency_code: string;
      minor_unit: number;
    }[]
  >`
    WITH today AS (
      SELECT (${now}::timestamptz AT TIME ZONE COALESCE(
        (SELECT timezone FROM app.school_settings
         WHERE school_id = current_setting('app.school_id')::uuid),
        'UTC'
      ))::date AS d
    )
    SELECT w.id::text AS id, w.academic_year_id::text AS academic_year_id,
           w.closes_on::text AS closes_on,
           -- The licence's programme values (000234): the school's override price in the licence's
           -- currency, else the global version's.
           COALESCE(
             (SELECT o.parent_price_minor FROM app.ai_programme_school_overrides AS o
              WHERE o.id = l.ai_programme_override_id AND o.school_id = l.school_id
                AND o.price_currency_id = l.currency_id AND o.parent_price_minor IS NOT NULL),
             (SELECT p.parent_price_minor FROM app.ai_programme_version_prices AS p
              WHERE p.version_id = l.ai_programme_version_id AND p.currency_id = l.currency_id)
           )::text AS price_minor,
           c.code AS currency_code, c.minor_unit::int AS minor_unit
    FROM app.ai_optin_windows AS w
    JOIN app.school_licenses AS l ON l.id = w.license_id AND l.school_id = w.school_id
    JOIN app.currencies AS c ON c.id = l.currency_id
    CROSS JOIN today
    WHERE w.school_id = current_setting('app.school_id')::uuid
      AND w.closed_at IS NULL
      AND w.opens_on <= today.d AND w.closes_on >= today.d
      AND l.status IN ('awaiting_payment', 'active')
    LIMIT 1
  `;
  return row ?? null;
}

/** Tell parents of eligible children without an opt-in, once per child and window. */
async function availabilityNotices(
  tx: TransactionSql,
  schoolName: string,
  locale: TemplateLocale,
  now: Date,
): Promise<{ children: number; notifications: number }> {
  const window = await openWindow(tx, now);
  if (!window || window.price_minor === null) return { children: 0, notifications: 0 };

  const children = await tx<{ student_id: string; name: string; parents: string[] }[]>`
    SELECT s.id::text AS student_id,
           COALESCE(NULLIF(btrim(concat_ws(' ', s.first_name, s.last_name)), ''), 'Student') AS name,
           array_agg(DISTINCT pcl.parent_user_id::text) AS parents
    FROM app.students AS s
    JOIN app.parent_child_links AS pcl ON pcl.student_id = s.id AND pcl.school_id = s.school_id
    JOIN app.users AS u ON u.id = pcl.parent_user_id AND u.school_id = pcl.school_id
    WHERE s.school_id = current_setting('app.school_id')::uuid
      AND s.status = 'enrolled'
      AND u.status IN ('invited', 'active')
      AND (
        NOT EXISTS (
          SELECT 1 FROM app.ai_optin_window_scopes AS sc
          WHERE sc.school_id = s.school_id AND sc.window_id = ${window.id}::uuid
        )
        OR EXISTS (
          SELECT 1
          FROM app.student_sections AS ss
          JOIN app.sections AS sec ON sec.id = ss.section_id AND sec.school_id = ss.school_id
          JOIN app.ai_optin_window_scopes AS sc
            ON sc.school_id = ss.school_id AND sc.window_id = ${window.id}::uuid
           AND (sc.section_id = sec.id OR sc.grade_level_id = sec.grade_level_id)
          WHERE ss.school_id = s.school_id AND ss.student_id = s.id
            AND ss.academic_year_id = ${window.academic_year_id}::uuid
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.ai_optins AS o
        WHERE o.school_id = s.school_id AND o.student_id = s.id
          AND o.academic_year_id = ${window.academic_year_id}::uuid AND o.status = 'active'
      )
      AND NOT EXISTS (
        SELECT 1 FROM app.ai_optin_window_notices AS n
        WHERE n.school_id = s.school_id AND n.window_id = ${window.id}::uuid AND n.student_id = s.id
      )
    GROUP BY s.id, s.first_name, s.last_name
    ORDER BY s.id
  `;

  const price = money(Number(window.price_minor), window.minor_unit, window.currency_code);
  let notifications = 0;
  let told = 0;
  for (const child of children) {
    const [claimed] = await tx<{ student_id: string }[]>`
      INSERT INTO app.ai_optin_window_notices (school_id, window_id, student_id, recipients)
      VALUES (current_setting('app.school_id')::uuid, ${window.id}::uuid, ${child.student_id}::uuid,
              ${child.parents.length})
      ON CONFLICT ON CONSTRAINT pk_ai_optin_window_notices DO NOTHING
      RETURNING student_id::text AS student_id
    `;
    if (!claimed) continue;
    for (const parent of child.parents) {
      await notify(
        tx,
        parent,
        NOTIFICATION_TYPES.AI_OPTIN_AVAILABLE,
        locale,
        { childName: child.name, schoolName, price, closesOn: window.closes_on },
        { route: "/parent/student-ai", student_id: child.student_id, window_id: window.id },
      );
      notifications += 1;
    }
    told += 1;
  }
  return { children: told, notifications };
}

/** Leadership's daily summary of new opt-ins; false when there were none. */
async function dailySummary(tx: TransactionSql, locale: TemplateLocale): Promise<boolean> {
  const fresh = await tx<{ id: string }[]>`
    UPDATE app.ai_optins SET admins_notified_at = CURRENT_TIMESTAMP,
           updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE school_id = current_setting('app.school_id')::uuid AND admins_notified_at IS NULL
    RETURNING id::text AS id
  `;
  if (fresh.length === 0) return false;
  const [counts] = await tx<{ active: number; waiting: number }[]>`
    SELECT count(*)::int AS active, (count(*) FILTER (WHERE seat_id IS NULL))::int AS waiting
    FROM app.ai_optins AS o
    WHERE o.school_id = current_setting('app.school_id')::uuid AND o.status = 'active'
      AND o.academic_year_id IN (
        SELECT academic_year_id FROM app.ai_optins
        WHERE school_id = current_setting('app.school_id')::uuid
          AND id = ANY(${fresh.map((row) => row.id)}::uuid[])
      )
  `;
  const admins = await tx<{ user_id: string }[]>`
    SELECT DISTINCT ur.user_id::text AS user_id
    FROM app.user_roles AS ur
    JOIN app.users AS u ON u.id = ur.user_id AND u.school_id = ur.school_id
    WHERE ur.school_id = current_setting('app.school_id')::uuid
      AND ur.role IN ('ORG_ADMIN'::app.user_role, 'PRINCIPAL'::app.user_role)
      AND u.status = 'active'
  `;
  for (const admin of admins) {
    await notify(
      tx,
      admin.user_id,
      NOTIFICATION_TYPES.AI_OPTIN_SUMMARY,
      locale,
      {
        newCount: String(fresh.length),
        totalCount: String(counts?.active ?? 0),
        waitingCount: String(counts?.waiting ?? 0),
      },
      { route: "/", kind: "ai_optin_summary" },
    );
  }
  return admins.length > 0;
}

export async function runAiOptInNotices(
  sql: Sql,
  now: Date,
  log: BillingLogger,
  options: { schoolIds?: readonly string[]; summary?: boolean } = {},
): Promise<AiOptInNoticesResult> {
  const allSchools = await sql<{ id: string; name: string }[]>`
    SELECT id::text AS id, name FROM app.schools ORDER BY id
  `;
  const schools = options.schoolIds
    ? allSchools.filter((s) => options.schoolIds!.includes(s.id))
    : allSchools;
  const summary = options.summary ?? now.getUTCHours() === AI_OPTIN_SUMMARY_HOUR_UTC;
  const result: AiOptInNoticesResult = {
    schools: schools.length,
    children: 0,
    parentNotifications: 0,
    summaries: 0,
    failedSchools: 0,
  };

  for (const school of schools) {
    try {
      await withSystemTenantTx(sql, { schoolId: school.id }, async (tx) => {
        const locale = await schoolLocale(tx);
        const told = await availabilityNotices(tx, school.name, locale, now);
        result.children += told.children;
        result.parentNotifications += told.notifications;
        if (summary && (await dailySummary(tx, locale))) result.summaries += 1;
      });
    } catch (err) {
      result.failedSchools += 1;
      log.warn({ err, school_id: school.id }, "ai opt-in notices failed for school");
    }
  }

  log.info({ ...result }, "ai opt-in notices complete");
  return result;
}
