/**
 * Wake the malware scanner while a material is still uploading.
 *
 * On fly.io the scanner (infra/fly/scanner.toml) scales to zero: the first connection to its Flycast
 * address makes fly's proxy start the machine, and clamd needs about 30 seconds (freshclam plus the
 * signature load) before it answers. Left alone, that cold start begins only when the scan worker
 * connects, i.e. after the file has been PUT and confirmed. Knocking on clamd when the upload is
 * initiated starts the machine in parallel with the upload instead, so by confirm time clamd is
 * usually up or nearly so.
 *
 * The knock is one TCP connection that sends clamd's `zPING` and is torn down on the first answer,
 * error or after a few seconds, whichever comes first. Whatever happens, the request that triggered
 * it is never delayed or failed: the caller does not await it, and every error is swallowed. The
 * scan worker keeps its own readiness wait (CLAMD_STARTUP_WAIT_MS in apps/workers), so a knock that
 * never lands only costs the head start.
 *
 * Knocks are throttled per process: once the proxy has started the machine it stays up for several
 * minutes after the last connection, so a second knock within {@link WARMUP_THROTTLE_MS} would buy
 * nothing.
 */

import { createConnection } from "node:net";

/** One knock's own limit. Long enough for the proxy to accept the connection and start the machine. */
export const WARMUP_TIMEOUT_MS = 5_000;
/** Minimum gap between two knocks from one API process. */
export const WARMUP_THROTTLE_MS = 30_000;

const PING_COMMAND = Buffer.from("zPING\0", "utf8");

export interface ScannerWarmupConfig {
  host: string;
  port: number;
  timeoutMs?: number;
  throttleMs?: number;
  now?: () => number;
}

/** Fire-and-forget. Never throws, never rejects, never needs awaiting. */
export type ScannerWarmup = () => void;

export function createScannerWarmup(config: ScannerWarmupConfig): ScannerWarmup {
  const timeoutMs = config.timeoutMs ?? WARMUP_TIMEOUT_MS;
  const throttleMs = config.throttleMs ?? WARMUP_THROTTLE_MS;
  const now = config.now ?? Date.now;
  let lastKnockAt = Number.NEGATIVE_INFINITY;

  return () => {
    const at = now();
    if (at - lastKnockAt < throttleMs) return;
    lastKnockAt = at;
    try {
      const socket = createConnection({ host: config.host, port: config.port });
      const close = () => socket.destroy();
      // The socket must never keep the process alive or surface an error.
      socket.unref();
      socket.setTimeout(timeoutMs, close);
      socket.on("error", close);
      socket.on("data", close);
      socket.on("connect", () => {
        socket.write(PING_COMMAND, () => undefined);
      });
    } catch {
      // A malformed host or a socket limit: the scan still runs, just without the head start.
    }
  };
}
