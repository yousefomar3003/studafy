/**
 * In-process counters for the outbox relay. No external metrics library — each counter is a
 * plain number in a plain object, exported as a JSON snapshot for the health endpoint. This is
 * the honest starting point: a Prometheus/Datadog exporter is an integration, not a foundation.
 */

export interface RelayMetrics {
  published: number;
  failed: number;
  lagMsTotal: number;
  lagCount: number;
}

const metrics: RelayMetrics = {
  published: 0,
  failed: 0,
  lagMsTotal: 0,
  lagCount: 0,
};

export function incrementPublished(count: number): void {
  metrics.published += count;
}

export function incrementFailed(): void {
  metrics.failed += 1;
}

export function recordLag(lagMs: number): void {
  metrics.lagMsTotal += lagMs;
  metrics.lagCount += 1;
}

export function snapshot(): Readonly<RelayMetrics> & { avgLagMs: number } {
  return {
    ...metrics,
    avgLagMs: metrics.lagCount === 0 ? 0 : Math.round(metrics.lagMsTotal / metrics.lagCount),
  };
}

export function resetMetrics(): void {
  metrics.published = 0;
  metrics.failed = 0;
  metrics.lagMsTotal = 0;
  metrics.lagCount = 0;
}
