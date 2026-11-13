# @studafy/workers

BullMQ worker process for Studafy. It owns the Redis connection, the queue registry, and the
worker bootstrap that later tickets attach real job processors to.

See [`docs/queue-catalog.md`](docs/queue-catalog.md) for what each queue is for.

## Architecture

- [`src/env.ts`](src/env.ts) — validates the environment once at startup (fail fast, mirrors
  `apps/api`'s `env.ts`).
- [`src/connection.ts`](src/connection.ts) — the BullMQ connection factory. Sets
  `maxRetriesPerRequest: null` (required by BullMQ) and `lazyConnect: true` (no socket opens until
  first use).
- [`src/registry.ts`](src/registry.ts) — `QUEUE_REGISTRY`, one entry per queue in
  `QUEUE_NAMES` (`@studafy/constants`), each with its own concurrency and processor.
- [`src/worker.ts`](src/worker.ts) — `startWorkers` creates one BullMQ `Worker` per registry
  entry; `shutdownWorkers` drains them on shutdown.
- [`src/index.ts`](src/index.ts) — process entrypoint: loads env, opens the connection, starts the
  workers, wires `SIGTERM`/`SIGINT`.

## Environment

| Variable              | Type                                    | Default                  | Notes                                      |
| --------------------- | --------------------------------------- | ------------------------ | ------------------------------------------ |
| `NODE_ENV`            | `development` \| `test` \| `production` | `development`            |                                            |
| `REDIS_URL`           | string                                  | `redis://localhost:6379` | BullMQ connection                          |
| `SHUTDOWN_TIMEOUT_MS` | integer `>= 0`                          | `10000`                  | max time to wait for active jobs to finish |

## Commands

```sh
bun run dev          # start with hot reload (bun --watch), requires Redis at REDIS_URL
bun run build        # bundle to dist/
bun run check-types  # tsc --noEmit
bun run lint         # eslint .
bun test             # run the unit test suite (no Redis required)
bun run smoke-test   # end-to-end: start workers, enqueue a job, wait for it to complete (requires Redis)
```

## Graceful shutdown

On `SIGTERM` or `SIGINT`, every worker stops pulling new jobs and waits for jobs it is already
processing to finish — this is BullMQ's `Worker.close()` behavior, not something this app
implements itself. That wait is bounded by `SHUTDOWN_TIMEOUT_MS`; any worker still open past the
deadline is force-closed so shutdown can't hang forever. The logic lives in
[`src/worker.ts`](src/worker.ts) (`shutdownWorkers`) and is unit-tested with fake workers, so it
doesn't require a live Redis to verify.

To verify by hand: start `bun run dev`, enqueue a slow job (or run `smoke-test` and send the
process a signal mid-run), then send `SIGTERM` and confirm the process logs "waiting for active
jobs to finish…" and doesn't exit until the job completes or `SHUTDOWN_TIMEOUT_MS` elapses.
