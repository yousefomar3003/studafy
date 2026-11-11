/**
 * The shared shape of the workers' always-on polling loops (outbox relay, entitlement invalidator,
 * email dispatcher): run a cycle, go straight round again while it finds work, and back off
 * exponentially while it does not.
 *
 * Each of those loops used to sleep a fixed 0.5-1 s between empty cycles, and each empty cycle ran
 * one transaction per school. Most of the time there is nothing to do, so the database spent almost
 * all of its statements confirming that. The loops now ask one discovery query per cycle
 * (`app.outbox_pending_school_ids`) and this helper stretches the gap between empty cycles from
 * `minIdleMs` to `maxIdleMs`, so an idle deployment costs a handful of statements every few seconds
 * whatever the number of schools.
 *
 * The first cycle after work arrives is at most `maxIdleMs` away, which is what each caller's
 * `maxIdleMs` has to be chosen against (the entitlement invalidator's is lower than the others for
 * its <5 s propagation SLA). Finding work resets the delay to `minIdleMs`, so a burst is drained at
 * full speed and the next quiet spell starts from the fast end again. A failing cycle backs off the
 * same way, which also keeps a database outage from turning into a tight error loop.
 */

export interface IdleBackoffOptions {
  /** The delay after the first empty cycle. */
  minIdleMs: number;
  /** The ceiling the delay grows to while cycles stay empty. */
  maxIdleMs: number;
  /** Growth per empty cycle. Default 2. */
  factor?: number;
}

/** The delay schedule on its own, so it can be tested without timers. */
export class IdleBackoff {
  private readonly minIdleMs: number;
  private readonly maxIdleMs: number;
  private readonly factor: number;
  private current: number;

  constructor(options: IdleBackoffOptions) {
    this.minIdleMs = options.minIdleMs;
    this.maxIdleMs = Math.max(options.minIdleMs, options.maxIdleMs);
    this.factor = options.factor ?? 2;
    this.current = this.minIdleMs;
  }

  /** Work was found: go round again at once, and start the next quiet spell from the fast end. */
  reset(): void {
    this.current = this.minIdleMs;
  }

  /** Nothing was found (or the cycle failed): how long to wait now. Grows the next wait. */
  nextDelay(): number {
    const delay = this.current;
    this.current = Math.min(this.maxIdleMs, Math.round(this.current * this.factor));
    return delay;
  }
}

export interface PollLoopOptions extends IdleBackoffOptions {
  /** One cycle. Resolves to how much work it did; 0 means idle. */
  cycle: () => Promise<number>;
  /** Called when a cycle rejects. The loop carries on after backing off. */
  onError: (err: unknown) => void;
  /** Test seam for observing the waits. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface PollLoopHandle {
  /** Stop after the current cycle; an in-progress idle wait ends at once. */
  stop(): void;
  /** Resolves when the loop has exited. */
  readonly done: Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function startPollLoop(options: PollLoopOptions): PollLoopHandle {
  const backoff = new IdleBackoff(options);
  const controller = new AbortController();
  const sleep = options.sleep ?? abortableSleep;

  const run = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      let worked = false;
      try {
        worked = (await options.cycle()) > 0;
      } catch (err) {
        options.onError(err);
      }
      if (controller.signal.aborted) break;
      if (worked) {
        // More may be waiting (a full batch, or rows that arrived meanwhile): sleeping on a backlog
        // would turn it into a multiple of the poll interval.
        backoff.reset();
        continue;
      }
      await sleep(backoff.nextDelay(), controller.signal);
    }
  };

  const done = run();
  return {
    stop: () => controller.abort(),
    done,
  };
}
