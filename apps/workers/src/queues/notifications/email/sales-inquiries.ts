/**
 * Sales-inquiry notifications: emails the Studafy sales inbox about each new "Talk to us" inquiry.
 *
 * Runs inside the email dispatcher's poll cycle rather than as its own job, so it shares the
 * dispatcher's pool, SES sender and rate limiter. `app.sales_inquiries` is global (no school_id;
 * studafy_admin only, migration 000125), so it is read under `withSystemTx`, not a tenant tx.
 *
 * One row per transaction, claimed `FOR UPDATE SKIP LOCKED`, mirroring the outbox rows: the send
 * and the `notified_at` stamp commit together, so a crash mid-send re-sends next cycle rather than
 * dropping the notification. Transient SES errors leave the row untouched; any other failure counts
 * an attempt and records the error, and a row stops being retried after MAX_NOTIFY_ATTEMPTS. The
 * inquiry itself is never lost: the console lists it whether or not the email went out.
 */

import { withSystemTx } from "../../../db/tenant-tx";

import { isRetryableSendError } from "./sender";
import { isSuppressed } from "./suppressions";
import { renderSalesInquiryEmail } from "./templates";

import type { EmailDispatcherContext } from "./dispatcher";
import type { TransactionSql } from "postgres";

export const SALES_INQUIRY_EMAIL_SETTING = "sales.inquiry_notification_email";
export const MAX_NOTIFY_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 1000;
const CONSOLE_PATH = "/portal/platform/inquiries";

interface PendingInquiryRow {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  school_name: string;
  job_title: string | null;
  country: string | null;
  student_count: number | null;
  message: string | null;
  source_path: string | null;
  created_at: Date;
}

type InquiryOutcome = "sent" | "skipped" | "failed" | "empty";

async function loadRecipient(tx: TransactionSql): Promise<string | null> {
  const [row] = await tx<{ text_value: string | null }[]>`
    SELECT text_value FROM app.platform_settings WHERE key = ${SALES_INQUIRY_EMAIL_SETTING}
  `;
  return row?.text_value?.trim() || null;
}

async function processOne(ctx: EmailDispatcherContext): Promise<InquiryOutcome> {
  return withSystemTx(ctx.db, async (tx) => {
    const [row] = await tx<PendingInquiryRow[]>`
      SELECT id, full_name, email, phone, school_name, job_title, country, student_count, message,
             source_path, created_at
      FROM app.sales_inquiries
      WHERE notified_at IS NULL AND notify_attempts < ${MAX_NOTIFY_ATTEMPTS}
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (!row) return "empty";

    const fail = async (error: string): Promise<InquiryOutcome> => {
      await tx`
        UPDATE app.sales_inquiries
        SET notify_attempts = notify_attempts + 1,
            last_notify_error = ${error.slice(0, MAX_ERROR_LENGTH) || "unknown error"},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${row.id}::uuid
      `;
      return "failed";
    };

    const recipient = await loadRecipient(tx);
    if (!recipient) return fail(`platform setting ${SALES_INQUIRY_EMAIL_SETTING} is not set`);

    if (await isSuppressed(tx, recipient)) {
      ctx.logger.warn(
        { recipient },
        "sales inquiry notification skipped — inbox address suppressed",
      );
      return fail(`recipient ${recipient} is on the suppression list`);
    }

    const content = renderSalesInquiryEmail({
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      schoolName: row.school_name,
      jobTitle: row.job_title,
      country: row.country,
      studentCount: row.student_count,
      message: row.message,
      sourcePath: row.source_path,
      submittedAt: row.created_at.toISOString(),
      consoleUrl: `${ctx.config.frontendUrl}${CONSOLE_PATH}`,
    });

    try {
      await ctx.sender.send({ to: recipient, replyTo: row.email, ...content });
    } catch (err) {
      if (isRetryableSendError(err)) throw err;
      return fail(err instanceof Error ? err.message : String(err));
    }

    await tx`
      UPDATE app.sales_inquiries
      SET notified_at = CURRENT_TIMESTAMP, last_notify_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${row.id}::uuid
    `;
    return "sent";
  });
}

/** Notifies the sales inbox about up to `batchSize` new inquiries. Returns how many it handled. */
export async function processSalesInquiries(ctx: EmailDispatcherContext): Promise<number> {
  let processed = 0;
  for (let i = 0; i < ctx.config.batchSize; i++) {
    const outcome = await processOne(ctx);
    if (outcome === "empty") break;
    processed += 1;
    if (outcome === "sent") await ctx.limiter.wait();
  }
  return processed;
}
