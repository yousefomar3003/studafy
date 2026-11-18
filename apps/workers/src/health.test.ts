/**
 * QA-046: a wedged worker is visible.
 *
 * Fly ignores the Dockerfile HEALTHCHECK, workers.toml had no [checks], and nothing scraped
 * /metrics, so a workers machine whose loops stopped (Redis gone, a hung query) looked healthy
 * while emails, push, scans and billing sweeps silently stopped. Now /healthz on WORKERS_HEALTH_PORT
 * reports each poll loop's last completed cycle and each BullMQ worker's state, Fly checks it, and
 * a heartbeat line goes to the logs every minute for an absence alert.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { evaluateHealth, startHealthServer } from "./health";
import { startPollLoop } from "./queues/poll-loop";

const MIN = 60_000;

describe("evaluateHealth (QA-046)", () => {
  const base = { startedAt: 0, staleAfterMs: 5 * MIN };

  test("healthy when every loop cycled recently and every worker runs", () => {
    const report = evaluateHealth({
      ...base,
      now: 10 * MIN,
      loops: [{ name: "email", lastCycleAt: () => 9 * MIN }],
      workers: [{ name: "billing", isRunning: () => true }],
    });
    expect(report).toEqual({ ok: true, stale: [], stopped: [] });
  });

  test("a loop silent for more than the threshold is stale", () => {
    const report = evaluateHealth({
      ...base,
      now: 10 * MIN,
      loops: [
        { name: "email", lastCycleAt: () => 4 * MIN },
        { name: "relay", lastCycleAt: () => 9 * MIN },
      ],
      workers: [],
    });
    expect(report).toEqual({ ok: false, stale: ["email"], stopped: [] });
  });

  test("a loop that never completed a cycle is stale once the startup grace has passed", () => {
    const loops = [{ name: "push", lastCycleAt: () => null }];
    expect(evaluateHealth({ ...base, now: MIN, loops, workers: [] }).ok).toBe(true);
    expect(evaluateHealth({ ...base, now: 6 * MIN, loops, workers: [] }).stale).toEqual(["push"]);
  });

  test("a BullMQ worker that stopped running is reported", () => {
    const report = evaluateHealth({
      ...base,
      now: MIN,
      loops: [],
      workers: [{ name: "scan", isRunning: () => false }],
    });
    expect(report).toEqual({ ok: false, stale: [], stopped: ["scan"] });
  });
});

describe("poll loop heartbeat (QA-046)", () => {
  test("lastCycleAt advances after each cycle, failed ones included", async () => {
    let calls = 0;
    const loop = startPollLoop({
      minIdleMs: 1,
      maxIdleMs: 1,
      onError: () => undefined,
      cycle: async () => {
        calls += 1;
        if (calls === 1) throw new Error("db down");
        return 0;
      },
    });
    expect(loop.lastCycleAt()).toBeNull();
    await Bun.sleep(20);
    await loop.stop();
    expect(loop.lastCycleAt()).toBeNumber();
  });
});

describe("/healthz (QA-046)", () => {
  test("answers 200 when healthy and 503 with the culprits when not", async () => {
    let ok = true;
    const server = startHealthServer({
      port: 0,
      evaluate: () =>
        ok ? { ok, stale: [], stopped: [] } : { ok, stale: ["email"], stopped: ["scan"] },
    });
    try {
      const healthy = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(healthy.status).toBe(200);
      ok = false;
      const sick = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(sick.status).toBe(503);
      expect(await sick.json()).toEqual({ ok: false, stale: ["email"], stopped: ["scan"] });
      expect((await fetch(`http://127.0.0.1:${server.port}/other`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });
});

describe("Fly monitors the services (QA-046)", () => {
  const fly = join(import.meta.dir, "../../../infra/fly");
  const read = (file: string) => readFileSync(join(fly, file), "utf8");

  test("workers.toml checks /healthz on the health port", () => {
    const toml = read("workers.toml");
    expect(toml).toMatch(/^\s*\[checks\.[a-z_]+\]/m);
    expect(toml).toMatch(/path\s*=\s*"\/healthz"/);
    expect(toml).toMatch(/port\s*=\s*8081/);
  });

  for (const file of ["api.toml", "workers.toml", "realtime.toml"]) {
    test(`${file} exposes /metrics on 9464 to Fly's Prometheus`, () => {
      const toml = read(file);
      expect(toml).toMatch(/^\[metrics\]\s*\n\s*port\s*=\s*9464\s*\n\s*path\s*=\s*"\/metrics"/m);
    });
  }
});
