/**
 * The push consumer: every inbox notification also reaches the recipient's phone.
 *
 * Only one producer (the grades.published dispatcher) used to send a push. Messages, announcements,
 * fee notices, attendance alerts and the school-event notices (school-events.ts) only ever landed in
 * the in-app inbox. This consumer closes that gap for all of them at once: it claims inbox rows whose
 * `push_dispatched_at` is NULL (000216), stamps them, and sends each through FCM to the recipient's
 * live devices.
 *
 * ## At most once
 *
 * The claim and the stamp commit before any send, and the sends run outside the transaction, so no
 * database connection is pinned across FCM calls. A crash between COMMIT and a send loses that one
 * push -- the inbox row is still there -- and never sends one twice. For a phone alert that is the
 * right trade: a duplicate buzz is worse than a missed one whose content is a tap away.
 *
 * ## What is not sent
 *
 * - The recipient turned the type's push channel off (a missing preference row means on, as in the
 *   dispatcher -- the seed trigger writes `true`).
 * - It is inside their quiet hours (unless the type is urgent; none is today).
 * - The row is older than {@link STALE_PUSH_MS}: a backlog drained after an outage should not buzz
 *   phones with hour-old news.
 * - They have no live device.
 *
 * Rows a producer already pushed itself (the grades dispatcher) are inserted with the stamp set.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { discoverPendingSchools } from "../outbox-discovery";
import { startPollLoop } from "../poll-loop";

import { loadPushRoutes, revokeDevices } from "./delivery.worker";
import { incrementNoTokens, incrementPruned, incrementSent } from "./push";
import { isUrgent, isWithinQuietHours } from "./quiet-hours";

import type { PollLoopHandle } from "../poll-loop";
import type { PushDevice, PushSender } from "./push";
import type { Sql, TransactionSql } from "postgres";

const STALE_PUSH_MS = 30 * 60 * 1000;

interface ClaimedRow {
  id: string;
  user_id: string;
  notification_type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface RecipientState {
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  local_time: string;
}

export interface PlannedPush {
  notificationId: string;
  userId: string;
  notificationType: string;
  title: string;
  body: string;
  route: string;
  devices: PushDevice[];
}

export interface PushCycleResult {
  claimed: number;
  sent: number;
  skipped: number;
}

export interface PushConsumerLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

async function loadRecipientState(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<RecipientState> {
  const [row] = await tx<RecipientState[]>`
    SELECT
      settings.quiet_hours_start::text AS quiet_hours_start,
      settings.quiet_hours_end::text AS quiet_hours_end,
      (CURRENT_TIMESTAMP AT TIME ZONE coalesce(
        settings.timezone, school_settings.timezone, 'UTC'
      ))::time::text AS local_time
    FROM app.users AS target_user
    LEFT JOIN app.user_notification_settings AS settings
      ON settings.user_id = target_user.id
     AND settings.school_id = target_user.school_id
    LEFT JOIN app.school_settings AS school_settings
      ON school_settings.school_id = target_user.school_id
    WHERE target_user.id = ${userId}::uuid
      AND target_user.school_id = ${schoolId}::uuid
  `;
  return row ?? { quiet_hours_start: null, quiet_hours_end: null, local_time: "12:00:00" };
}

async function pushEnabled(
  tx: TransactionSql,
  userId: string,
  notificationType: string,
): Promise<boolean> {
  const [row] = await tx<{ enabled: boolean }[]>`
    SELECT enabled
    FROM app.notification_preferences
    WHERE user_id = ${userId}::uuid
      AND notification_type = ${notificationType}::app.notification_type
      AND channel = 'push'
  `;
  return row?.enabled ?? true;
}

/**
 * Claim and stamp one school's pending rows, and work out which of them to send and where. Exported
 * for tests; the sends happen in {@link pushSchoolNotifications}.
 */
export async function claimPushes(
  db: Sql,
  schoolId: string,
  batchSize: number,
  now: Date = new Date(),
): Promise<{ claimed: number; planned: PlannedPush[] }> {
  return withSystemTenantTx(db, { schoolId }, async (tx) => {
    const rows = await tx<ClaimedRow[]>`
      UPDATE app.notifications
      SET push_dispatched_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT id
        FROM app.notifications
        WHERE school_id = ${schoolId}::uuid
          AND push_dispatched_at IS NULL
        ORDER BY created_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, user_id, notification_type::text AS notification_type, title, body,
                metadata, created_at
    `;

    const planned: PlannedPush[] = [];
    const stateByUser = new Map<string, RecipientState>();
    const devicesByUser = new Map<string, PushDevice[]>();

    for (const row of rows) {
      if (now.getTime() - new Date(row.created_at).getTime() > STALE_PUSH_MS) continue;
      if (!(await pushEnabled(tx, row.user_id, row.notification_type))) continue;

      let state = stateByUser.get(row.user_id);
      if (!state) {
        state = await loadRecipientState(tx, schoolId, row.user_id);
        stateByUser.set(row.user_id, state);
      }
      if (
        !isUrgent(row.notification_type) &&
        isWithinQuietHours(state.local_time, state.quiet_hours_start, state.quiet_hours_end)
      ) {
        continue;
      }

      let devices = devicesByUser.get(row.user_id);
      if (!devices) {
        devices = (await loadPushRoutes(tx, schoolId, row.user_id)).tokens;
        devicesByUser.set(row.user_id, devices);
      }
      if (devices.length === 0) {
        incrementNoTokens();
        continue;
      }

      const route = row.metadata?.route;
      planned.push({
        notificationId: row.id,
        userId: row.user_id,
        notificationType: row.notification_type,
        title: row.title,
        body: row.body,
        route: typeof route === "string" ? route : "",
        devices,
      });
    }

    return { claimed: rows.length, planned };
  });
}

/** One cycle for one school: claim, then send outside the transaction, then prune dead tokens. */
export async function pushSchoolNotifications(
  db: Sql,
  sender: PushSender,
  schoolId: string,
  batchSize: number,
  logger: PushConsumerLogger,
): Promise<PushCycleResult> {
  const { claimed, planned } = await claimPushes(db, schoolId, batchSize);
  let sent = 0;
  const unregistered: string[] = [];

  for (const push of planned) {
    try {
      const result = await sender.send(
        {
          title: push.title,
          body: push.body,
          route: push.route,
          notificationType: push.notificationType,
          dispatchLogId: push.notificationId,
        },
        push.devices,
      );
      sent += result.sent;
      incrementSent(result.sent);
      unregistered.push(...result.unregisteredDeviceIds);
    } catch (err) {
      // The row is already stamped: at most once (see the header). Logged so a broken credential
      // is visible rather than silently dropping every push.
      logger.error(
        { err, school_id: schoolId, notification_id: push.notificationId },
        "push send failed",
      );
    }
  }

  if (unregistered.length > 0) {
    const ids = [...new Set(unregistered)];
    await withSystemTenantTx(db, { schoolId }, (tx) => revokeDevices(tx, schoolId, ids));
    incrementPruned(ids.length);
  }

  return { claimed, sent, skipped: claimed - planned.length };
}

/** The always-on loop: discover schools with unpushed inbox rows, drain each. */
export function startPushConsumer(ctx: {
  db: Sql;
  sender: PushSender;
  logger: PushConsumerLogger;
  batchSize?: number;
  pollIntervalMs?: number;
  maxIdleIntervalMs?: number;
}): PollLoopHandle {
  const batchSize = ctx.batchSize ?? 100;
  return startPollLoop({
    minIdleMs: ctx.pollIntervalMs ?? 1_000,
    maxIdleMs: ctx.maxIdleIntervalMs ?? 5_000,
    cycle: async () => {
      let total = 0;
      for (const schoolId of await discoverPendingSchools(ctx.db, "push")) {
        try {
          const result = await pushSchoolNotifications(
            ctx.db,
            ctx.sender,
            schoolId,
            batchSize,
            ctx.logger,
          );
          total += result.claimed;
          if (result.claimed > 0) {
            ctx.logger.info({ school_id: schoolId, ...result }, "notification pushes processed");
          }
        } catch (err) {
          ctx.logger.error({ err, school_id: schoolId }, "notification push cycle failed");
        }
      }
      return total;
    },
    onError: (err) => ctx.logger.error({ err }, "notification push loop failed"),
  });
}
