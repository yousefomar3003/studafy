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
 * - Transient SES failures (throttle, 5xx, network) roll the row back so it retries next cycle.
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
 */

import { withSystemTenantTx } from "../../../db/tenant-tx";

import { claimEmailRows } from "./claim";
import { resolveEmail } from "./resolve";
import { loadSchoolIds } from "./schools";
import { isRetryableSendError } from "./sender";
import { isSuppressed } from "./suppressions";

import type { RateLimiter } from "./rate-limiter";
import type { ClaimedOutboxRow } from "./resolve";
import type { EmailSender } from "./sender";
import type { Sql, TransactionSql } from "postgres";

export interface EmailDispatcherConfig {
  /** Max rows to process per school per poll cycle. */
  batchSize: number;
  /** Milliseconds to sleep when an entire poll cycle finds zero claimable rows. */
  pollIntervalMs: number;
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

export type RowOutcome = "sent" | "suppressed" | "duplicate" | "failed";

/** The max length the email_deliveries.last_error CHECK enforces. */
const MAX_ERROR_LENGTH = 1000;

async function loadSchoolName(db: Sql, schoolId: string): Promise<string> {
  // app.schools is a global table with no RLS, so this needs no tenant context.
  const [row] = await db<{ name: string }[]>`
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
 * Claim, send, and record one row inside the caller's tenant transaction. Returns the row's
 * terminal outcome, or "empty" when the school has nothing left to claim.
 */
async function processRow(
  tx: TransactionSql,
  ctx: EmailDispatcherContext,
  schoolName: string,
): Promise<RowOutcome | "empty"> {
  const rows = await claimEmailRows(tx, 1);
  if (rows.length === 0) return "empty";

  const row = rows[0];
  const resolved = resolveEmail(row, { frontendUrl: ctx.config.frontendUrl, schoolName });

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
    if (isRetryableSendError(err)) {
      // Let the transaction roll back: the row stays undispatched and the next cycle retries.
      throw err;
    }
    await tx`
      UPDATE app.email_deliveries
      SET status = 'failed', last_error = ${clampError(err)}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${deliveryId}::uuid
    `;
    await markDispatched(tx, row);
    return "failed";
  }
}

/** One poll cycle for a single school. Returns the number of rows processed. */
async function processSchool(ctx: EmailDispatcherContext, schoolId: string): Promise<number> {
  const schoolName = await loadSchoolName(ctx.db, schoolId);

  let processed = 0;
  for (let i = 0; i < ctx.config.batchSize; i++) {
    const outcome = await withSystemTenantTx(ctx.db, { schoolId }, (tx) =>
      processRow(tx, ctx, schoolName),
    );

    if (outcome === "empty") break;
    processed += 1;

    // Only actual sends consume rate tokens; suppressed, duplicate, and failed rows cost nothing.
    if (outcome === "sent") {
      await ctx.limiter.wait();
    }
  }
  return processed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One full poll cycle across all schools. Returns the total number of rows processed. */
async function pollOnce(ctx: EmailDispatcherContext): Promise<number> {
  // Enumerate per cycle, not once at startup: a school that registers after the process boots
  // must start receiving its emails without a redeploy.
  const schoolIds = await loadSchoolIds(ctx.db);
  let total = 0;
  for (const schoolId of schoolIds) {
    try {
      total += await processSchool(ctx, schoolId);
    } catch (err) {
      ctx.logger.error({ err, school_id: schoolId }, "email dispatch batch failed");
    }
  }
  return total;
}

/** Main email dispatcher loop. Runs until `stop()` is called. */
export function startEmailDispatcher(ctx: EmailDispatcherContext): DispatcherHandle {
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const count = await pollOnce(ctx);
        if (count === 0) {
          await sleep(ctx.config.pollIntervalMs);
        }
      } catch (err) {
        ctx.logger.error({ err }, "email dispatch cycle failed");
        await sleep(ctx.config.pollIntervalMs);
      }
    }
  };

  ctx.logger.info(
    { batchSize: ctx.config.batchSize, ratePerSecond: ctx.config.ratePerSecond },
    "email dispatcher started",
  );
  void loop();

  return {
    stop: () => {
      stopped = true;
      ctx.logger.info({}, "email dispatcher stopping");
    },
  };
}
