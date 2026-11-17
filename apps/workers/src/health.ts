/**
 * Workers liveness (QA-046). The process being up says nothing about whether it is working: a poll
 * loop stuck on a hung query, or a BullMQ worker that closed after a Redis failure, leaves the
 * machine "healthy" while emails, push, scans and billing sweeps stop. This reports the parts that
 * do the work:
 *
 * - every poll loop must have completed a cycle (successful or not) within `staleAfterMs`; a cycle
 *   that keeps failing is already an error-log alert, a loop that stops cycling is not;
 * - every BullMQ worker must still be running.
 *
 * Fly polls /healthz (infra/fly/workers.toml [checks]), and `startHeartbeat` logs the same report
 * every minute for the Axiom absence alert (docs/runbooks/alerts.md).
 */

export interface LoopProbe {
  name: string;
  lastCycleAt(): number | null;
}

export interface WorkerProbe {
  name: string;
  isRunning(): boolean;
}

export interface HealthReport {
  ok: boolean;
  /** Loops with no completed cycle within the threshold. */
  stale: string[];
  /** BullMQ workers no longer running. */
  stopped: string[];
}

export function evaluateHealth(input: {
  loops: LoopProbe[];
  workers: WorkerProbe[];
  now: number;
  startedAt: number;
  staleAfterMs: number;
}): HealthReport {
  const stale = input.loops
    .filter((loop) => input.now - (loop.lastCycleAt() ?? input.startedAt) > input.staleAfterMs)
    .map((loop) => loop.name);
  const stopped = input.workers.filter((w) => !w.isRunning()).map((w) => w.name);
  return { ok: stale.length === 0 && stopped.length === 0, stale, stopped };
}

/** GET /healthz: 200 with the report when healthy, 503 with it when not. Internal port only. */
export function startHealthServer(options: { port: number; evaluate: () => HealthReport }): {
  port: number;
  stop: () => void;
} {
  const server = Bun.serve({
    port: options.port,
    fetch(request) {
      if (new URL(request.url).pathname !== "/healthz") {
        return new Response("not found", { status: 404 });
      }
      const report = options.evaluate();
      return Response.json(report, { status: report.ok ? 200 : 503 });
    },
  });
  return { port: server.port ?? options.port, stop: () => void server.stop(true) };
}

/** Log the report every `intervalMs`: info when healthy, error when not (an alert either way). */
export function startHeartbeat(options: {
  intervalMs: number;
  evaluate: () => HealthReport;
  logger: {
    info: (fields: Record<string, unknown>, msg: string) => void;
    error: (fields: Record<string, unknown>, msg: string) => void;
  };
}): { stop: () => void } {
  const timer = setInterval(() => {
    const report = options.evaluate();
    if (report.ok) options.logger.info({ ...report }, "workers heartbeat");
    else options.logger.error({ ...report }, "workers heartbeat: unhealthy");
  }, options.intervalMs);
  return { stop: () => clearInterval(timer) };
}
