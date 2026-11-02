/**
 * School sign-up application emails. Two independent streams over `app.school_applications`
 * (global, studafy_admin only, migration 000139):
 *
 *   - team:      each new application -> the onboarding inbox (platform setting), with every field
 *                the applicant filled in and a link to review it in the platform console.
 *   - applicant: each decision -> the applicant's own Google/Microsoft sign-in address, telling them
 *                to sign in (approved) or why not and how to apply again (rejected).
 *
 * Same mechanics as sales-inquiries.ts: runs inside the email dispatcher's poll cycle, one row per
 * transaction claimed `FOR UPDATE SKIP LOCKED` so the send and its `*_notified_at` stamp commit
 * together, transient SES errors leave the row for the next cycle, and any other failure counts an
 * attempt and stops after MAX_NOTIFY_ATTEMPTS. The application itself is never lost: the console
 * lists it whether or not an email went out.
 */

import { withSystemTx } from "../../../db/tenant-tx";

import { MAX_NOTIFY_ATTEMPTS } from "./sales-inquiries";
import { isRetryableSendError } from "./sender";
import { isSuppressed } from "./suppressions";
import {
  renderSchoolApplicationApprovedEmail,
  renderSchoolApplicationEmail,
  renderSchoolApplicationRejectedEmail,
} from "./templates";

import type { EmailDispatcherContext } from "./dispatcher";
import type { RenderedEmail } from "./templates";
import type { TransactionSql } from "postgres";

export const SCHOOL_APPLICATION_EMAIL_SETTING = "onboarding.application_notification_email";
const MAX_ERROR_LENGTH = 1000;
const CONSOLE_PATH = "/portal/platform/applications";

interface ApplicationRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  provider: string;
  applicant_email: string;
  applicant_name: string;
  applicant_job_title: string | null;
  applicant_phone: string;
  school_name: string;
  school_email: string | null;
  country_name: string;
  currency_code: string;
  city: string;
  address: string;
  website: string | null;
  student_count: number | null;
  message: string | null;
  proof_file_name: string;
  review_note: string | null;
  created_at: Date;
}

type Outcome = "sent" | "failed" | "empty";
type Stream = "team" | "applicant";

async function claim(tx: TransactionSql, stream: Stream): Promise<ApplicationRow | undefined> {
  const pending =
    stream === "team"
      ? tx`a.team_notified_at IS NULL AND a.team_notify_attempts < ${MAX_NOTIFY_ATTEMPTS}`
      : tx`a.status <> 'pending' AND a.applicant_notified_at IS NULL
           AND a.applicant_notify_attempts < ${MAX_NOTIFY_ATTEMPTS}`;
  const [row] = await tx<ApplicationRow[]>`
    SELECT a.id, a.status, a.provider, a.applicant_email, a.applicant_name, a.applicant_job_title,
           a.applicant_phone, a.school_name, a.school_email, co.name AS country_name,
           cu.code AS currency_code, a.city, a.address, a.website, a.student_count, a.message,
           a.proof_file_name, a.review_note, a.created_at
    FROM app.school_applications a
    JOIN app.countries co ON co.id = a.country_id
    JOIN app.currencies cu ON cu.id = a.default_currency_id
    WHERE ${pending}
    ORDER BY a.created_at
    LIMIT 1
    FOR UPDATE OF a SKIP LOCKED
  `;
  return row;
}

async function markFailed(
  tx: TransactionSql,
  stream: Stream,
  id: string,
  error: string,
): Promise<Outcome> {
  const message = error.slice(0, MAX_ERROR_LENGTH) || "unknown error";
  if (stream === "team") {
    await tx`
      UPDATE app.school_applications
      SET team_notify_attempts = team_notify_attempts + 1, team_last_notify_error = ${message},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
    `;
  } else {
    await tx`
      UPDATE app.school_applications
      SET applicant_notify_attempts = applicant_notify_attempts + 1,
          applicant_last_notify_error = ${message}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
    `;
  }
  return "failed";
}

async function markSent(tx: TransactionSql, stream: Stream, id: string): Promise<void> {
  if (stream === "team") {
    await tx`
      UPDATE app.school_applications
      SET team_notified_at = CURRENT_TIMESTAMP, team_last_notify_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
    `;
  } else {
    await tx`
      UPDATE app.school_applications
      SET applicant_notified_at = CURRENT_TIMESTAMP, applicant_last_notify_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid
    `;
  }
}

async function loadTeamRecipient(tx: TransactionSql): Promise<string | null> {
  const [row] = await tx<{ text_value: string | null }[]>`
    SELECT text_value FROM app.platform_settings WHERE key = ${SCHOOL_APPLICATION_EMAIL_SETTING}
  `;
  return row?.text_value?.trim() || null;
}

function renderTeam(ctx: EmailDispatcherContext, row: ApplicationRow): RenderedEmail {
  return renderSchoolApplicationEmail({
    applicantName: row.applicant_name,
    applicantEmail: row.applicant_email,
    applicantJobTitle: row.applicant_job_title,
    applicantPhone: row.applicant_phone,
    provider: row.provider,
    schoolName: row.school_name,
    schoolEmail: row.school_email,
    country: row.country_name,
    city: row.city,
    address: row.address,
    website: row.website,
    studentCount: row.student_count,
    currency: row.currency_code,
    message: row.message,
    proofFileName: row.proof_file_name,
    submittedAt: row.created_at.toISOString(),
    consoleUrl: `${ctx.config.frontendUrl}${CONSOLE_PATH}/${row.id}`,
  });
}

function renderDecision(ctx: EmailDispatcherContext, row: ApplicationRow): RenderedEmail {
  const data = {
    applicantName: row.applicant_name,
    schoolName: row.school_name,
    provider: row.provider,
    reason: row.review_note,
  };
  return row.status === "approved"
    ? renderSchoolApplicationApprovedEmail({
        ...data,
        actionUrl: `${ctx.config.frontendUrl}/auth/login`,
      })
    : renderSchoolApplicationRejectedEmail({
        ...data,
        actionUrl: `${ctx.config.frontendUrl}/signup`,
      });
}

async function processOne(ctx: EmailDispatcherContext, stream: Stream): Promise<Outcome> {
  return withSystemTx(ctx.db, async (tx) => {
    const row = await claim(tx, stream);
    if (!row) return "empty";

    let recipient: string;
    let replyTo: string | undefined;
    if (stream === "team") {
      const inbox = await loadTeamRecipient(tx);
      if (!inbox) {
        return markFailed(
          tx,
          stream,
          row.id,
          `platform setting ${SCHOOL_APPLICATION_EMAIL_SETTING} is not set`,
        );
      }
      recipient = inbox;
      replyTo = row.applicant_email;
    } else {
      recipient = row.applicant_email;
    }

    if (await isSuppressed(tx, recipient)) {
      ctx.logger.warn({ stream }, "school application email skipped — recipient suppressed");
      return markFailed(tx, stream, row.id, `recipient ${recipient} is on the suppression list`);
    }

    const content = stream === "team" ? renderTeam(ctx, row) : renderDecision(ctx, row);
    try {
      await ctx.sender.send({ to: recipient, ...(replyTo ? { replyTo } : {}), ...content });
    } catch (err) {
      if (isRetryableSendError(err)) throw err;
      return markFailed(tx, stream, row.id, err instanceof Error ? err.message : String(err));
    }

    await markSent(tx, stream, row.id);
    return "sent";
  });
}

/** Sends up to `batchSize` pending school-application emails. Returns how many it handled. */
export async function processSchoolApplications(ctx: EmailDispatcherContext): Promise<number> {
  let processed = 0;
  for (const stream of ["team", "applicant"] as const) {
    for (let i = 0; i < ctx.config.batchSize; i++) {
      const outcome = await processOne(ctx, stream);
      if (outcome === "empty") break;
      processed += 1;
      if (outcome === "sent") await ctx.limiter.wait();
    }
  }
  return processed;
}
