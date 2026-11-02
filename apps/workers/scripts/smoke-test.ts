import { Queue, QueueEvents } from "bullmq";

import { createRedisConnection } from "../src/connection";
import { loadEnv } from "../src/env";
import { QUEUE_REGISTRY } from "../src/registry";
import { shutdownWorkers, startWorkers } from "../src/worker";

/**
 * Manual, Redis-required smoke test for the acceptance criterion "workers start, register
 * queues, and process a test job." Not part of `bun test` — it needs a real Redis instance
 * (`REDIS_URL`, defaults to redis://localhost:6379). Run with `bun run smoke-test`.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const connection = createRedisConnection(env);
  const workers = startWorkers(QUEUE_REGISTRY, connection);

  const targetQueue = QUEUE_REGISTRY[0].name;
  const queue = new Queue(targetQueue, { connection });
  const events = new QueueEvents(targetQueue, { connection });
  await events.waitUntilReady();

  const job = await queue.add("smoke-test", { source: "smoke-test.ts" });
  console.log(`Enqueued job ${job.id} on "${targetQueue}", waiting for it to complete…`);

  const result = await job.waitUntilFinished(events, 15_000);
  console.log("Job completed:", result);

  await events.close();
  await queue.close();
  await shutdownWorkers(workers, env.SHUTDOWN_TIMEOUT_MS);
  connection.disconnect();
}

main().catch((error: unknown) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
