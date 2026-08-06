/**
 * In-process counters for the OCR stage. No external metrics library — each counter is a plain
 * number in a plain object, exported as a JSON snapshot for the health endpoint. This is the honest
 * starting point: a Prometheus/Datadog exporter is an integration, not a foundation. Same shape as
 * the outbox-relay and push metrics.
 *
 * "Cost" is deliberately not a currency figure: OCR's cost is compute time, so latency is the
 * measured quantity and cost-per-page is documented as a derivation of it in docs/adr/0007.
 */
export interface OcrMetrics {
  /** Pages recognized (one per raster passed to the engine). */
  recognizedPages: number;
  /** Pages whose confidence fell below the flagging threshold. */
  flaggedPages: number;
  /** Times the primary-language pass was re-run across candidate languages. */
  languageReruns: number;
  /** Recognize calls that threw. */
  errors: number;
  latencyMsTotal: number;
  latencyCount: number;
}

const metrics: OcrMetrics = {
  recognizedPages: 0,
  flaggedPages: 0,
  languageReruns: 0,
  errors: 0,
  latencyMsTotal: 0,
  latencyCount: 0,
};

export function recordRecognizedPage(params: {
  latencyMs: number;
  confidence: number;
  threshold: number;
}): void {
  metrics.recognizedPages += 1;
  metrics.latencyMsTotal += params.latencyMs;
  metrics.latencyCount += 1;
  if (params.confidence < params.threshold) {
    metrics.flaggedPages += 1;
  }
}

export function recordLanguageRerun(): void {
  metrics.languageReruns += 1;
}

export function recordOcrError(): void {
  metrics.errors += 1;
}

export function snapshot(): Readonly<OcrMetrics> & { avgLatencyMs: number } {
  return {
    ...metrics,
    avgLatencyMs:
      metrics.latencyCount === 0 ? 0 : Math.round(metrics.latencyMsTotal / metrics.latencyCount),
  };
}

export function resetMetrics(): void {
  metrics.recognizedPages = 0;
  metrics.flaggedPages = 0;
  metrics.languageReruns = 0;
  metrics.errors = 0;
  metrics.latencyMsTotal = 0;
  metrics.latencyCount = 0;
}
