/**
 * Channel delivery for the notification dispatcher (ST-139).
 *
 * The dispatcher decides *what* each recipient should be told; this carries one already-decided
 * message to one recipient on one channel.
 *
 * ## Two channels, two honest answers
 *
 * `push` is real here. It resolves the recipient's live devices, sends through FCM with the
 * deep-link route in the payload, prunes tokens FCM reports unregistered, and advances the dispatch
 * log to `delivered` — but only when FCM accepted at least one message. Marking `delivered` when
 * nothing was handed to FCM would make the audit trail assert something false, which is the exact
 * question app.notification_dispatch_logs exists to answer.
 *
 * `email` still has no provider in this file: transactional email runs through the SES dispatcher
 * in email/, not through this delivery job, so a grade-posted email that lands here is recorded as
 * `no provider configured` at `warn` and left at `enqueued`. A status of `enqueued` that never
 * advances is a visible gap; a `delivered` that never happened is a lie. Same for a push recipient
 * with no live device: the row stays `enqueued`, the gap is visible, and the metrics and log line
 * say why.
 *
 * ## What the per-user device cap is for
 *
 * A user can hold many registered tokens (phone, tablet, web, re-registered devices). FCM bills per
 * message and the value of the Nth device is near zero, so the channel targets the
 * `MAX_DEVICES_PER_USER` most-recently-seen live devices and counts the overflow in metrics. The
 * overflow is not revoked — those are the user's real devices, not garbage — the cap is a cost
 * bound on fan-out, nothing more.
 *
 * ## Why a crash between send and confirm is acceptable
 *
 * The delivery job sits after the dispatcher's reserve-confirm boundary (the reservation is already
 * confirmed by the time this job exists), so its own crash window is at-least-once: a process death
 * between FCM accepting the message and the `delivered` update sends a duplicate push on retry.
 * That is the same trade the email channel already documents, and the one the reserve-confirm
 * design exists to keep bounded to this single window.
 */

import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";

import {
  incrementDevicesSkippedCap,
  incrementNoTokens,
  incrementPruned,
  incrementSent,
} from "./push";

import type { DeliverNotificationJobData } from "./dispatcher.worker";
import type { PushDevice, PushSender } from "./push";
import type { Sql, TransactionSql } from "postgres";

export interface DeliveryLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

export interface DeliveryDependencies {
  databaseUrl: string;
  log: DeliveryLogger;
  push: PushSender;
}

export interface DeliveryResult {
  processed: true;
  channel: string;
  /** How many live routes the recipient has — devices for push, an address for email. */
  routesResolved: number;
  /** True when the channel handed the message to a provider. False never means "not attempted". */
  sent: boolean;
  /** Device rows revoked as unregistered. Always 0 for non-push channels. */
  pruned: number;
}

interface RouteRow {
  route_count: number;
}

interface PushRouteRow {
  id: string;
  fcm_token: string;
  platform: string;
}

/**
 * The most recent devices a push is sent to. A hard ceiling per user, so one account with a dozen
 * stale-but-unrevoked registrations cannot fan a single notification out to all of them. See the
 * header for why the overflow is measured, not revoked.
 */
export const MAX_DEVICES_PER_USER = 5;

/**
 * How many live routes this recipient has on this channel.
 *
 * Used for the email branch only, whose provider lives elsewhere. The push branch reads tokens
 * directly via `loadPushRoutes` because it needs the rows, not a count.
 */
async function countRoutes(
  tx: TransactionSql,
  schoolId: string,
  recipientId: string,
): Promise<number> {
  const [row] = await tx<RouteRow[]>`
    SELECT count(*)::int AS route_count
    FROM app.users
    WHERE id = ${recipientId}::uuid
      AND school_id = ${schoolId}::uuid
      AND email IS NOT NULL
  `;
  return row?.route_count ?? 0;
}

/**
 * The recipient's live push routes: the `MAX_DEVICES_PER_USER` most recently seen, plus how many
 * live devices there are in total. `total` is what makes the cap visible — routesResolved alone
 * would silently understate the route count for a heavy-device user.
 */
async function loadPushRoutes(
  tx: TransactionSql,
  schoolId: string,
  recipientId: string,
): Promise<{ tokens: PushDevice[]; total: number }> {
  const [count] = await tx<RouteRow[]>`
    SELECT count(*)::int AS route_count
    FROM app.user_devices
    WHERE school_id = ${schoolId}::uuid
      AND user_id = ${recipientId}::uuid
      AND revoked_at IS NULL
  `;

  const rows = await tx<PushRouteRow[]>`
    SELECT id, fcm_token, platform::text AS platform
    FROM app.user_devices
    WHERE school_id = ${schoolId}::uuid
      AND user_id = ${recipientId}::uuid
      AND revoked_at IS NULL
    ORDER BY last_seen DESC
    LIMIT ${MAX_DEVICES_PER_USER}
  `;

  return {
    tokens: rows.map((row) => ({
      id: row.id,
      token: row.fcm_token,
      platform: row.platform as PushDevice["platform"],
    })),
    total: count?.route_count ?? 0,
  };
}

/** Soft-revoke device rows FCM no longer recognises. The trail stays; only the route dies. */
async function revokeDevices(
  tx: TransactionSql,
  schoolId: string,
  deviceIds: string[],
): Promise<void> {
  await tx`
    UPDATE app.user_devices
    SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid
      AND id = ANY(${deviceIds}::uuid[])
      AND revoked_at IS NULL
  `;
}

/** Advance a dispatch log from `enqueued` to `delivered` once a provider accepted the message. */
async function markDelivered(
  tx: TransactionSql,
  schoolId: string,
  dispatchLogId: string,
): Promise<void> {
  await tx`
    UPDATE app.notification_dispatch_logs
    SET status = 'delivered', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${dispatchLogId}::uuid
      AND school_id = ${schoolId}::uuid
  `;
}

/**
 * Deliver one notification on the push channel.
 *
 * All the database work runs under `withSystemTenantTx` — token pruning writes rows owned by the
 * recipient, which the restrictive user policy would hide from an un-elevated session. The FCM call
 * itself deliberately runs outside any transaction: nothing a transaction can roll back should
 * undo a message FCM already accepted.
 */
async function deliverPush(
  sql: Sql,
  deps: DeliveryDependencies,
  data: DeliverNotificationJobData,
): Promise<DeliveryResult> {
  const { schoolId, recipientId, dispatchLogId, notificationType, title, body } = data;
  const route = data.route ?? "";

  const routes = await withSystemTenantTx(sql, { schoolId }, (tx) =>
    loadPushRoutes(tx, schoolId, recipientId),
  );

  if (routes.tokens.length === 0) {
    incrementNoTokens();
    deps.log.warn(
      {
        event: "notification_push_no_devices",
        school_id: schoolId,
        dispatch_log_id: dispatchLogId,
        recipient_id: recipientId,
        notification_type: notificationType,
      },
      "recipient has no live push devices; notification not sent",
    );
    return {
      processed: true,
      channel: "push",
      routesResolved: routes.total,
      sent: false,
      pruned: 0,
    };
  }

  if (routes.total > routes.tokens.length) {
    incrementDevicesSkippedCap(routes.total - routes.tokens.length);
  }

  let result;
  try {
    result = await deps.push.send(
      { title, body, route, notificationType, dispatchLogId },
      routes.tokens,
    );
  } catch (error) {
    deps.log.error(
      {
        event: "notification_push_send_failed",
        school_id: schoolId,
        dispatch_log_id: dispatchLogId,
        recipient_id: recipientId,
        notification_type: notificationType,
        err: error,
      },
      "push send failed; delivery job will retry",
    );
    throw error;
  }

  if (result.unregisteredDeviceIds.length > 0) {
    await withSystemTenantTx(sql, { schoolId }, (tx) =>
      revokeDevices(tx, schoolId, result.unregisteredDeviceIds),
    );
    incrementPruned(result.unregisteredDeviceIds.length);
    deps.log.info(
      {
        event: "notification_push_tokens_pruned",
        school_id: schoolId,
        dispatch_log_id: dispatchLogId,
        recipient_id: recipientId,
        count: result.unregisteredDeviceIds.length,
      },
      "revoked push tokens FCM reported unregistered",
    );
  }

  // Only a message FCM accepted is a delivered notification. Zero successes here means every token
  // was pruned or rejected — the log stays at `enqueued` as the visible gap that records it.
  if (result.sent > 0) {
    await withSystemTenantTx(sql, { schoolId }, (tx) => markDelivered(tx, schoolId, dispatchLogId));
    incrementSent(result.sent);
    deps.log.info(
      {
        event: "notification_push_delivered",
        school_id: schoolId,
        dispatch_log_id: dispatchLogId,
        recipient_id: recipientId,
        notification_type: notificationType,
        sent: result.sent,
        dry_run: result.dryRun,
      },
      "push delivered to at least one device",
    );
  }

  return {
    processed: true,
    channel: "push",
    routesResolved: routes.total,
    sent: result.sent > 0,
    pruned: result.unregisteredDeviceIds.length,
  };
}

/**
 * Deliver one notification on one channel.
 *
 * `databaseUrl` and the sender are dependencies rather than read from the environment so this is
 * callable from a test against a disposable database with a stub sender — the shape every other
 * processor in apps/workers uses.
 */
export async function processNotificationDelivery(
  data: DeliverNotificationJobData,
  deps: DeliveryDependencies,
): Promise<DeliveryResult> {
  const { schoolId, recipientId, channel, dispatchLogId } = data;

  // prepare: false is mandatory behind PgBouncer transaction pooling.
  const sql = postgres(deps.databaseUrl, { max: 2, idle_timeout: 20, prepare: false });

  try {
    if (channel === "push") {
      return await deliverPush(sql, deps, data);
    }

    const routesResolved = await withSystemTenantTx(sql, { schoolId }, async (tx) =>
      countRoutes(tx, schoolId, recipientId),
    );

    deps.log.warn(
      {
        event: "notification_delivery_no_provider",
        school_id: schoolId,
        dispatch_log_id: dispatchLogId,
        recipient_id: recipientId,
        channel,
        notification_type: data.notificationType,
        routes_resolved: routesResolved,
      },
      `no provider configured for channel ${channel}; notification was rendered but not sent`,
    );

    return { processed: true, channel, routesResolved, sent: false, pruned: 0 };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
