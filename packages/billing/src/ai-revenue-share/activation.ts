import { LIVE_STATUSES } from "../state-machine";

import type { RevenueShareAudit } from "./engine";
import type { TransactionSql } from "postgres";

/**
 * Putting a licence in force after the revenue share was credited on its invoice (000237, "A credit
 * that leaves a new licence's first instalment paid puts it in force (as a payment would)").
 *
 * One rule, shared by the API (settling after a payment, an invoice issued, the console's
 * recompute) and the workers' hourly job: `licencesToPutInForce` says which licences of the armed
 * school are now due to be in force, the same test the API's payment path applies --
 *
 *   * activate: a draft or awaiting-payment licence with an invoice (not void) whose first
 *     instalment is paid, or that is paid in full;
 *   * resume:   a licence stopped for non-payment (`nonpayment_suspended_at`) that has not ended and
 *     has no unpaid instalment past its cutoff (due date + the licence's grace days);
 *
 * and in both cases only while the school has no other active licence (one at a time).
 *
 * The API then puts them in force through its own `activateLicenseFor` / `resumeIfSettled` (status,
 * audit, entitlements, and the personal-subscription overlap credits and renewal stops that need the
 * payment providers). The workers use `activateLicence` below, which does the same status change
 * and audit; a licence whose seat holders still pay personally needs the providers, so the workers
 * leave it to the API (`personalSubscriptionsOnLicence`) -- the API's next settle for the school
 * finds it by this same state-based rule.
 */

export interface LicencesToPutInForce {
  activate: { licenseId: string; invoiceId: string }[];
  resume: string[];
}

/** UTC calendar day of an instant. */
const day = (now: Date) => now.toISOString().slice(0, 10);

export async function licencesToPutInForce(
  tx: TransactionSql,
  now: Date,
  options: {
    /**
     * Only invoices a revenue share credit went on (an ai_share_credit line): the workers' pass,
     * which acts on what its own settling changed and leaves every other activation to the API.
     */
    creditedOnly?: boolean;
  } = {},
): Promise<LicencesToPutInForce> {
  const credited = options.creditedOnly
    ? tx`AND EXISTS (
           SELECT 1 FROM app.license_invoice_lines AS line
           WHERE line.school_id = i.school_id AND line.invoice_id = i.id
             AND line.kind = 'ai_share_credit'
         )`
    : tx``;
  const [active] = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM app.school_licenses
    WHERE school_id = current_setting('app.school_id')::uuid AND status = 'active'
    LIMIT 1
  `;
  if (active) return { activate: [], resume: [] };

  const activate = await tx<{ license_id: string; invoice_id: string }[]>`
    SELECT DISTINCT ON (l.id) l.id::text AS license_id, i.id::text AS invoice_id
    FROM app.school_licenses AS l
    JOIN app.license_invoices AS i ON i.license_id = l.id AND i.school_id = l.school_id
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.status IN ('draft', 'awaiting_payment')
      AND i.status <> 'void'
      -- A Student AI weekly statement's invoice never puts a licence in force (000251).
      AND i.kind = 'licence'
      ${credited}
      AND (
        i.status = 'paid'
        OR (
          SELECT inst.status FROM app.license_invoice_instalments AS inst
          WHERE inst.school_id = i.school_id AND inst.invoice_id = i.id
          ORDER BY inst.position
          LIMIT 1
        ) = 'paid'
      )
    ORDER BY l.id, i.issue_date, i.created_at, i.id
  `;
  const resume = await tx<{ id: string }[]>`
    SELECT l.id::text AS id
    FROM app.school_licenses AS l
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.status = 'suspended'
      AND l.nonpayment_suspended_at IS NOT NULL
      AND l.ends_at > ${now}
      AND NOT EXISTS (
        SELECT 1
        FROM app.license_invoice_instalments AS inst
        JOIN app.license_invoices AS i ON i.id = inst.invoice_id AND i.school_id = inst.school_id
        WHERE inst.school_id = l.school_id
          AND i.license_id = l.id
          AND i.status IN ('issued', 'partially_paid')
          AND i.kind = 'licence'
          AND inst.status <> 'paid'
          AND inst.due_date + l.nonpayment_grace_days <= ${day(now)}::date
      )
    ORDER BY l.starts_at DESC, l.id
  `;
  return {
    // One licence at a time: the earliest-starting candidate first, the rest wait for the next pass.
    activate: activate.map((row) => ({ licenseId: row.license_id, invoiceId: row.invoice_id })),
    resume: resume.map((row) => row.id),
  };
}

/**
 * Whether any current seat holder of the licence still pays personally for what the seat gives
 * (a live personal tier subscription, or the per-student AI add-on): activating it then needs the
 * overlap credit and renewal stop the API records with the payment providers.
 */
export async function personalSubscriptionsOnLicence(
  tx: TransactionSql,
  licenseId: string,
  now: Date,
): Promise<boolean> {
  const live = [...LIVE_STATUSES];
  const [row] = await tx<{ found: boolean }[]>`
    WITH seats AS (
      SELECT user_id, student_id FROM app.license_seats
      WHERE school_id = current_setting('app.school_id')::uuid
        AND license_id = ${licenseId}::uuid
        AND unassigned_at IS NULL
    )
    SELECT EXISTS (
             SELECT 1 FROM app.user_subscriptions AS us
             WHERE us.school_id = current_setting('app.school_id')::uuid
               AND us.user_id IN (SELECT user_id FROM seats)
               AND us.status::text = ANY(${live})
               AND us.current_period_end > ${now}
           )
        OR EXISTS (
             SELECT 1 FROM app.ai_subscriptions AS ai
             WHERE ai.school_id = current_setting('app.school_id')::uuid
               AND ai.student_id IN (SELECT student_id FROM seats WHERE student_id IS NOT NULL)
               AND ai.status::text = ANY(${live})
               AND ai.current_period_end > ${now}
           ) AS found
  `;
  return row?.found ?? false;
}

/**
 * Put a draft or awaiting-payment licence in force (status active, activated_at set once), audited,
 * unless the school has an active licence already. Returns the seat holders whose entitlements the
 * caller must refresh, or null when nothing changed. The workers' counterpart of the API's
 * `transitionLicense(..., "active")` for a licence nobody pays personally on.
 */
export async function activateLicence(
  tx: TransactionSql,
  licenseId: string,
  audit: RevenueShareAudit,
): Promise<string[] | null> {
  const [changed] = await tx<{ id: string; before: string }[]>`
    UPDATE app.school_licenses AS l
    SET status = 'active', activated_at = COALESCE(l.activated_at, CURRENT_TIMESTAMP),
        updated_at = GREATEST(CURRENT_TIMESTAMP, l.updated_at)
    FROM (
      SELECT id, status FROM app.school_licenses
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ${licenseId}::uuid
      FOR UPDATE
    ) AS before
    WHERE l.school_id = current_setting('app.school_id')::uuid
      AND l.id = before.id
      AND before.status IN ('draft', 'awaiting_payment')
      AND NOT EXISTS (
        SELECT 1 FROM app.school_licenses AS other
        WHERE other.school_id = l.school_id AND other.status = 'active'
      )
    RETURNING l.id::text AS id, before.status AS before
  `;
  if (!changed) return null;
  await audit([
    {
      action: "update",
      targetTable: "school_licenses",
      targetId: changed.id,
      oldValues: { status: changed.before },
      newValues: { status: "active", reason: "ai_share_credit" },
    },
  ]);
  const holders = await tx<{ user_id: string }[]>`
    SELECT DISTINCT user_id::text AS user_id FROM app.license_seats
    WHERE school_id = current_setting('app.school_id')::uuid
      AND license_id = ${licenseId}::uuid
      AND unassigned_at IS NULL
  `;
  return holders.map((h) => h.user_id);
}

/** PostgreSQL's serialization failure and deadlock: the transaction may simply be run again. */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

export function isRetryableTransactionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_SQLSTATES.has(code);
}

/**
 * Run a whole transaction again when it failed on a serialization failure or a deadlock -- two
 * payments recorded for one school at once both settle its revenue share (the same entries and open
 * invoices). `run` must open its own transaction, so a retry starts from scratch. Up to `attempts`
 * tries in all, with a short, growing pause.
 */
export async function withTransactionRetry<T>(
  run: () => Promise<T>,
  options: { attempts?: number; pauseMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const pauseMs = options.pauseMs ?? 25;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= attempts || !isRetryableTransactionError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt));
    }
  }
}
