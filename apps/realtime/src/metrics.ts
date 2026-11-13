/**
 * In-process counters for outbox-to-room fan-out, exposed via `GET /metrics` (src/health.ts).
 * Same shape as apps/workers' per-queue metrics modules (e.g. outbox-relay/metrics.ts): plain
 * counters, no external metrics library, exported as a JSON snapshot — the honest starting point,
 * not a Prometheus/Datadog integration.
 */

export interface FanoutMetrics {
  /** Outbox events received on a routed `events:*:{event_name}` channel. */
  received: number;
  /** Room deliveries produced — one received event can fan out to more than one room. */
  roomDeliveries: number;
  /** Malformed channel or payload, discarded before routing. */
  dropped: number;
}

const metrics: FanoutMetrics = {
  received: 0,
  roomDeliveries: 0,
  dropped: 0,
};

export function incrementReceived(): void {
  metrics.received += 1;
}

export function incrementRoomDeliveries(count: number): void {
  metrics.roomDeliveries += count;
}

export function incrementDropped(): void {
  metrics.dropped += 1;
}

export function snapshot(): Readonly<FanoutMetrics> {
  return { ...metrics };
}

export function resetMetrics(): void {
  metrics.received = 0;
  metrics.roomDeliveries = 0;
  metrics.dropped = 0;
}
