/**
 * Channel delivery for the notification dispatcher (ST-139).
 *
 * The dispatcher decides *what* each recipient should be told; this carries one already-decided
 * message to one recipient on one channel.
 *
 * ## There is no provider, and this file says so out loud
 *
 * This repository contains no email, push or SMS client — no SES, SendGrid or Resend, no
 * firebase-admin, no Twilio. `app.user_devices` has stored FCM tokens since 000017 and nothing has
 * ever read them. Wiring one is a ticket of its own, with credentials, bounce handling and a
 * deliverability runbook attached.
 *
 * So this processor does the half that is real — resolve the route, mark the dispatch log — and
 * records the half that is not as an explicit, greppable `no provider configured` at `warn`, with
 * the dispatch log left at `enqueued` rather than advanced to `delivered`.
 *
 * That distinction is the whole point of the file. Marking these `delivered` would make the audit
 * trail assert something false, and "the parents were never told" would then be unanswerable from
 * the data — which is exactly the question app.notification_dispatch_logs exists to answer. A
 * status of `enqueued` that never advances is a visible gap; a status of `delivered` that never
 * happened is a lie.
 */

import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";

import type { DeliverNotificationJobData } from "./dispatcher.worker";
import type { TransactionSql } from "postgres";

export interface DeliveryLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

export interface DeliveryResult {
  processed: true;
  channel: string;
  /** How many live routes the recipient has — devices for push, an address for email. */
  routesResolved: number;
  /** False until a provider exists. Kept explicit so the caller cannot mistake this for a send. */
  sent: false;
}

interface RouteRow {
  route_count: number;
}

/**
 * How many live routes this recipient has on this channel.
 *
 * Resolved even though nothing can be sent yet, because it is the part that is genuinely
 * answerable now and it is what a provider integration would need first — and because a recipient
 * with zero routes is a different operational problem from a missing provider, worth distinguishing
 * in the logs before either is fixed.
 */
async function countRoutes(
  tx: TransactionSql,
  schoolId: string,
  recipientId: string,
  channel: string,
): Promise<number> {
  if (channel === "push") {
    const [row] = await tx<RouteRow[]>`
      SELECT count(*)::int AS route_count
      FROM app.user_devices
      WHERE school_id = ${schoolId}::uuid
        AND user_id = ${recipientId}::uuid
        AND revoked_at IS NULL
    `;
    return row?.route_count ?? 0;
  }

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
 * Deliver one notification on one channel.
 *
 * `databaseUrl` is a parameter rather than read from the environment so this is callable from a
 * test against a disposable database — the shape every other processor in apps/workers uses.
 */
export async function processNotificationDelivery(
  data: DeliverNotificationJobData,
  databaseUrl: string,
  log: DeliveryLogger,
): Promise<DeliveryResult> {
  const { schoolId, recipientId, channel, dispatchLogId } = data;

  // prepare: false is mandatory behind PgBouncer transaction pooling.
  const sql = postgres(databaseUrl, { max: 2, idle_timeout: 20, prepare: false });

  try {
    const routesResolved = await withSystemTenantTx(sql, { schoolId }, async (tx) =>
      countRoutes(tx, schoolId, recipientId, channel),
    );

    log.warn(
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

    return { processed: true, channel, routesResolved, sent: false };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
