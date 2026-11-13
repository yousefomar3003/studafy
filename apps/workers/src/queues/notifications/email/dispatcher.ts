/**
 * Email dispatcher — the polling loop that turns outbox events into SES sends.
 *
 * Mirrors the outbox relay's shape (claim, work, mark, repeat) with its own cursor, and processes
 * each row in its own tenant transaction so the claim, the delivery claim, the send, and the
 * dispatched-marking commit atomically. That single transaction is what makes the channel
 * at-least-once without duplicates:
 *
 * - If the process crashes mid-send, the transaction rolls back and the row stays undispatched —
 *   the email is re-attempted next cycle. Duplicate mail is only possible in the window between
 *   SES accepting the message and the commit, which at-least-once semantics permit.
 * - Transient send failures (throttle, 5xx, network) — and anything else that throws while
 *   resolving or sending — roll back to a savepoint, so no delivery row is left behind, and the
 *   row is rescheduled: `email_attempts` counts the failure and `email_next_attempt_at` (000200)
 *   pushes the next try out exponentially (30 s doubling to 1 h). The claim skips a row until then,
 *   so one failing message never blocks the school's later ones, and after
 *   EMAIL_MAX_SEND_ATTEMPTS it is dead-lettered: a terminal 'failed' delivery row records the last
 *   error and the event is marked dispatched. Before 000200 a transient failure rolled the whole
 *   transaction back and the row was retried every cycle, forever.
 * - Permanent failures (MessageRejected) commit a terminal 'failed' delivery row and mark the
 *   event dispatched, so a mailer that can never succeed does not spin forever.
 *
 * The dedup claim precedes the send: each recipient is claimed with INSERT ... ON CONFLICT DO
 * NOTHING on uq_email_deliveries_event_recipient, and only a row that won the insert is sent —
 * the same "the unique index is the arbiter" ordering as attendance_alert_logs (000056). Today
 * every email-relevant event has a single recipient, so the dispatcher is the only writer and the
 * conflict branch is unreachable; it exists so fan-out events stay safe if they are ever added.
 *
 * Claim scope is tenant isolation, not a school_id predicate: the per-row transaction runs under
 * withSystemTenantTx, so the FORCE'd RLS on app.outbox_events scopes the claim to the school
 * being processed and no other.
 *
 * Which schools to visit: each cycle asks one discovery statement which schools have claimable
 * email rows (`app.outbox_pending_school_ids('email')`) and whether the platform-level streams
 * (sales inquiries, school applications) have anything pending, and touches only those. Empty
 * cycles back off from `pollIntervalMs` to `maxIdleIntervalMs` (poll-loop.ts). Mail to a suspended
 * or closed school is not filtered out — dunning and deletion confirmations are exactly the mail
 * such a school still needs.
 */

import { withSystemTenantTx, withSystemTx } from "../../../db/tenant-tx";
import { pendingSchoolIdsFragment } from "../../outbox-discovery";
import { startPollLoop } from "../../poll-loop";

import { claimEmailRows } from "./claim";
import { resolveEmail } from "./resolve";
import { pendingSalesInquiriesExist, processSalesInquiries } from "./sales-inquiries";
import { pendingSchoolApplicationsExist, processSchoolApplications } from "./school-applications";
import { isRetryableSendError } from "./sender";
import { isSuppressed } from "./suppressions";

import type { ClaimedEmailRow } from "./claim";
import type { RateLimiter } from "./rate-limiter";
import type { ClaimedOutboxRow, ResolvedEmail } from "./resolve";
import type { EmailSender } from "./sender";
import type { Sql, TransactionSql } from "postgres";

export interface EmailDispatcherConfig {
  /** Max rows to process per school per poll cycle. */
  batchSize: number;
  /** Milliseconds to sleep after the first poll cycle that finds zero claimable rows. */
  pollIntervalMs: number;
  /**
   * The ceiling the idle sleep doubles up to while cycles keep finding nothing (poll-loop.ts).
   * Defaults to `pollIntervalMs`, i.e. no backoff.
   */
  maxIdleIntervalMs?: number;
  /** SES send pacing, sends per second. */
  ratePerSecond: number;
  /** Base URL for the action links embedded in rendered emails. */
  frontendUrl: string;
}

export interface EmailDispatcherLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export interface EmailDispatcherContext {
  db: Sql;
  sender: EmailSender;
  limiter: RateLimiter;
  config: EmailDispatcherConfig;
  logger: EmailDispatcherLogger;
}

export interface DispatcherHandle {
  stop(): void;
}

/** "deferred": the attempt failed transiently and the row was rescheduled (see the header). */
export type RowOutcome = "sent" | "suppressed" | "duplicate" | "failed" | "deferred";

/** The max length the email_deliveries.last_error CHECK enforces. */
const MAX_ERROR_LENGTH = 1000;

/**
 * Attempts before a transiently failing row is dead-lettered. 10 is also the ceiling of both
 * ck_email_deliveries_attempts and ck_outbox_events_email_attempts. With the schedule below the
 * last attempt lands about 3 hours after the first, which outlasts a typical provider incident.
 */
export const EMAIL_MAX_SEND_ATTEMPTS = 10;
const EMAIL_RETRY_BASE_MS = 30_000;
const EMAIL_RETRY_MAX_MS = 60 * 60 * 1000;

/** The wait before the next try, after `attempts` failed tries (1-based). Exported for tests. */
export function emailRetryDelayMs(attempts: number): number {
  return Math.min(EMAIL_RETRY_MAX_MS, EMAIL_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

async function loadSchoolName(tx: TransactionSql, schoolId: string): Promise<string> {
  // app.schools is a global table with no RLS; studafy_admin (the system tenant role) owns it.
  const [row] = await tx<{ name: string }[]>`
    SELECT name FROM app.schools WHERE id = ${schoolId}::uuid
  `;
  return row?.name ?? "Studafy";
}

async function recordDelivery(
  tx: TransactionSql,
  row: ClaimedOutboxRow,
  recipient: string,
  template: string,
): Promise<string | null> {
  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.email_deliveries (school_id, outbox_event_id, recipient, template)
    VALUES (${row.school_id}::uuid, ${row.id}, ${recipient}, ${template}::app.email_template)
    ON CONFLICT ON CONSTRAINT uq_email_deliveries_event_recipient DO NOTHING
    RETURNING id
  `;
  return inserted?.id ?? null;
}

async function markDispatched(tx: TransactionSql, row: ClaimedOutboxRow): Promise<void> {
  const now = new Date().toISOString();
  await tx`UPDATE app.outbox_events SET email_dispatched_at = ${now} WHERE id = ${row.id}`;
}

function clampError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, MAX_ERROR_LENGTH) || "unknown error";
}

/**
 * Send one resolved row and record the outcome. Runs inside a savepoint: anything thrown from here
 * rolls back this row's delivery row and leaves the rescheduling to `processRow`.
 */
async function deliverRow(
  tx: TransactionSql,
  ctx: EmailDispatcherContext,
  row: ClaimedOutboxRow,
  resolved: ResolvedEmail,
): Promise<RowOutcome> {
  if (await isSuppressed(tx, resolved.recipient)) {
    await recordDelivery(tx, row, resolved.recipient, resolved.template);
    await markDispatched(tx, row);
    ctx.logger.info(
      { event: row.event_name, recipient: resolved.recipient },
      "email skipped — address suppressed",
    );
    return "suppressed";
  }

  const deliveryId = await recordDelivery(tx, row, resolved.recipient, resolved.template);
  if (deliveryId === null) {
    // A delivery row already exists for this (event, recipient), so a previous run handled it.
    // Only a committed run can have written it, and a committed run also committed the
    // dispatched-marking — this branch just defends the loop against never making progress.
    await markDispatched(tx, row);
    return "duplicate";
  }

  try {
    const { messageId } = await ctx.sender.send({ to: resolved.recipient, ...resolved.content });
    await tx`
      UPDATE app.email_deliveries
      SET status = 'sent', message_id = ${messageId}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${deliveryId}::uuid
    `;
    await markDispatched(tx, row);
    return "sent";
  } catch (err) {
    // Transient: let the savepoint roll back and processRow reschedule the row.
    if (isRetryableSendError(err)) throw err;
    await tx`
      UPDATE app.email_deliveries
      SET status = 'failed', last_error = ${clampError(err)}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${deliveryId}::uuid
    `;
    await markDispatched(tx, row);
    return "failed";
  }
}

/**
 * Reschedule a row whose attempt threw, or dead-letter it once it has used its attempts. Runs in
 * the claim transaction after the attempt's savepoint was rolled back.
 */
async function rescheduleOrDeadLetter(
  tx: TransactionSql,
  ctx: EmailDispatcherContext,
  row: ClaimedEmailRow,
  resolved: ResolvedEmail | undefined,
  err: unknown,
): Promise<RowOutcome> {
  const attempts = row.email_attempts + 1;
  const lastError = clampError(err);

  if (attempts < EMAIL_MAX_SEND_ATTEMPTS) {
    const delayMs = emailRetryDelayMs(attempts);
    await tx`
      UPDATE app.outbox_events
      SET email_attempts = ${attempts},
          email_next_attempt_at = CURRENT_TIMESTAMP + make_interval(secs => ${delayMs / 1000})
      WHERE id = ${row.id}
    `;
    ctx.logger.warn(
      { err, event: row.event_name, outbox_id: row.id, attempts, retry_in_ms: delayMs },
      "email send failed; rescheduled",
    );
    return "deferred";
  }

  // Dead letter. The delivery row is the durable record of the give-up; when the row could not
  // even be resolved there is no recipient to key one on, and the log line is the record.
  if (resolved) {
    await tx`
      INSERT INTO app.email_deliveries
        (school_id, outbox_event_id, recipient, template, status, attempts, last_error)
      VALUES (${row.school_id}::uuid, ${row.id}, ${resolved.recipient},
              ${resolved.template}::app.email_template, 'failed', ${attempts}, ${lastError})
      ON CONFLICT ON CONSTRAINT uq_email_deliveries_event_recipient DO NOTHING
    `;
  }
  await tx`
    UPDATE app.outbox_events
    SET email_attempts = ${attempts}, email_next_attempt_at = NULL,
        email_dispatched_at = ${new Date().toISOString()}
    WHERE id = ${row.id}
  `;
  ctx.logger.error(
    { err, event: row.event_name, outbox_id: row.id, attempts },
    "email send failed permanently after retries; dead-lettered",
  );
  return "failed";
}

/**
 * Claim, send, and record one row inside the caller's tenant transaction. Returns the row's
 * outcome, or "empty" when the school has nothing left to claim.
 */
async function processRow(
  tx: TransactionSql,
  ctx: EmailDispatcherContext,
  schoolName: (tx: TransactionSql) => Promise<string>,
): Promise<RowOutcome | "empty"> {
  const rows = await claimEmailRows(tx, 1);
  if (rows.length === 0) return "empty";

  const row = rows[0]!;
  const attempt: { resolved?: ResolvedEmail } = {};
  try {
    return await tx.savepoint(async (sp) => {
      attempt.resolved = resolveEmail(row, {
        frontendUrl: ctx.config.frontendUrl,
        schoolName: await schoolName(sp),
      });
      return deliverRow(sp, ctx, row, attempt.resolved);
    });
  } catch (err) {
    return rescheduleOrDeadLetter(tx, ctx, row, attempt.resolved, err);
  }
}

/**
 * One poll cycle for a single school. Returns the number of rows processed. Exported for tests,
 * which drive it directly rather than racing the polling loop.
 */
export async function processSchool(
  ctx: EmailDispatcherContext,
  schoolId: string,
): Promise<number> {
  // Read once a row has actually been claimed, then reused for the rest of the batch.
  let schoolName: string | undefined;
  const loadName = async (tx: TransactionSql): Promise<string> =>
    (schoolName ??= await loadSchoolName(tx, schoolId));

  let processed = 0;
  for (let i = 0; i < ctx.config.batchSize; i++) {
    const outcome = await withSystemTenantTx(ctx.db, { schoolId }, (tx) =>
      processRow(tx, ctx, loadName),
    );

    if (outcome === "empty") break;
    processed += 1;

    // Only actual sends consume rate tokens; suppressed, duplicate, failed and deferred rows cost
    // nothing.
    if (outcome === "sent") {
      await ctx.limiter.wait();
    }
  }
  return processed;
}

interface PendingWork {
  schoolIds: string[];
  platformPending: boolean;
}

/** The cycle's one discovery statement: schools with claimable rows, and platform-level mail. */
async function discoverPendingWork(ctx: EmailDispatcherContext): Promise<PendingWork> {
  return withSystemTx(ctx.db, async (tx) => {
    const [row] = await tx<{ school_ids: string[]; platform_pending: boolean }[]>`
      SELECT ${pendingSchoolIdsFragment(tx, "email")} AS school_ids,
             (${pendingSalesInquiriesExist(tx)} OR ${pendingSchoolApplicationsExist(tx)})
               AS platform_pending
    `;
    return {
      schoolIds: row?.school_ids ?? [],
      platformPending: row?.platform_pending ?? false,
    };
  });
}

/**
 * One full poll cycle across the schools (and platform streams) with pending mail. Returns the
 * total number of rows processed. Exported for tests.
 */
export async function pollOnce(ctx: EmailDispatcherContext): Promise<number> {
  // Discovered per cycle, not once at startup: a school that registers after the process boots
  // must start receiving its emails without a redeploy.
  const pending = await discoverPendingWork(ctx);
  let total = 0;
  for (const schoolId of pending.schoolIds) {
    try {
      total += await processSchool(ctx, schoolId);
    } catch (err) {
      ctx.logger.error({ err, school_id: schoolId }, "email dispatch batch failed");
    }
  }
  if (!pending.platformPending) return total;
  // Platform-level mail with no school behind it: "Talk to us" inquiries for the sales inbox.
  try {
    total += await processSalesInquiries(ctx);
  } catch (err) {
    ctx.logger.error({ err }, "sales inquiry notification batch failed");
  }
  // School sign-up applications: the onboarding inbox, and applicants about decisions.
  try {
    total += await processSchoolApplications(ctx);
  } catch (err) {
    ctx.logger.error({ err }, "school application notification batch failed");
  }
  return total;
}

/** Main email dispatcher loop. Runs until `stop()` is called. */
export function startEmailDispatcher(ctx: EmailDispatcherContext): DispatcherHandle {
  const loop = startPollLoop({
    minIdleMs: ctx.config.pollIntervalMs,
    maxIdleMs: ctx.config.maxIdleIntervalMs ?? ctx.config.pollIntervalMs,
    cycle: () => pollOnce(ctx),
    onError: (err) => ctx.logger.error({ err }, "email dispatch cycle failed"),
  });

  ctx.logger.info(
    { batchSize: ctx.config.batchSize, ratePerSecond: ctx.config.ratePerSecond },
    "email dispatcher started",
  );

  return {
    stop: () => {
      loop.stop();
      ctx.logger.info({}, "email dispatcher stopping");
    },
  };
}
