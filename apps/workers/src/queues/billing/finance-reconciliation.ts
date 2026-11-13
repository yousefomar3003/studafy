/**
 * Daily finance reconciliation trigger.
 *
 * The reconciliation itself lives in apps/api (`POST /api/finance/reconciliation/run`,
 * modules/finance/jobs): it needs the per-school ERPNext clients and site resolution that only the
 * API holds. Its docs always intended an external scheduler to call it daily; this job is that
 * scheduler, so the run happens without a separate cron service. The endpoint authenticates the
 * call with the shared RECONCILIATION_API_KEY service key, not a user session.
 */

export interface FinanceReconciliationOptions {
  /** apps/api's base URL (`API_BASE_URL`). */
  apiBaseUrl: string;
  /** The service key the endpoint checks (`RECONCILIATION_API_KEY`). */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  /** A day's reconciliation over every school can take a while; bounded so a hung API frees the job. */
  timeoutMs?: number;
}

export interface FinanceReconciliationResult {
  schools_processed: number;
  total_drift_detected: number;
  total_auto_healed: number;
  total_unresolved: number;
  job_run_at: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Run it; throws on any non-2xx so BullMQ's retry/backoff re-runs the day's reconciliation. */
export async function runFinanceReconciliation(
  options: FinanceReconciliationOptions,
): Promise<FinanceReconciliationResult> {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchFn(
    `${options.apiBaseUrl.replace(/\/$/, "")}/api/finance/reconciliation/run`,
    {
      method: "POST",
      headers: { "X-Api-Key": options.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`finance reconciliation answered ${response.status}`);
  }
  return (await response.json()) as FinanceReconciliationResult;
}
