/**
 * In-process counters for the push channel. No external metrics library — each counter is a
 * plain number in a plain object, exported as a JSON snapshot, the same starting point the
 * outbox relay uses. A Prometheus/Datadog exporter is an integration, not a foundation.
 *
 * Failures are deliberately absent. A push send that throws is retried by BullMQ and, if it
 * exhausts its retries, lands in app.notification_dead_letters with `notification.dispatchFailed`
 * raised — that ledger is the honest failure record, and a per-attempt counter here would
 * double-count every transient blip. These counters describe what FCM accepted and what the
 * channel itself changed, which is the part nothing else records.
 */

export interface PushMetrics {
  /** Messages FCM accepted (per device). */
  sent: number;
  /** Device rows revoked because FCM reported their token unregistered. */
  pruned: number;
  /** Delivery attempts for a recipient with no live device. */
  noTokens: number;
  /** Live devices over the per-user cap, not targeted. */
  devicesSkippedCap: number;
}

const metrics: PushMetrics = {
  sent: 0,
  pruned: 0,
  noTokens: 0,
  devicesSkippedCap: 0,
};

export function incrementSent(count: number): void {
  metrics.sent += count;
}

export function incrementPruned(count: number): void {
  metrics.pruned += count;
}

export function incrementNoTokens(): void {
  metrics.noTokens += 1;
}

export function incrementDevicesSkippedCap(count: number): void {
  metrics.devicesSkippedCap += count;
}

export function snapshot(): Readonly<PushMetrics> {
  return { ...metrics };
}

export function resetMetrics(): void {
  metrics.sent = 0;
  metrics.pruned = 0;
  metrics.noTokens = 0;
  metrics.devicesSkippedCap = 0;
}
