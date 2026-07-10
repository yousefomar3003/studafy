# Redis usage conventions

Source of the Redis instance: [`infra/terraform/modules/redis`](../../infra/terraform/modules/redis).
This doc is the conventions apps must follow to use it correctly — the Terraform module provisions
the instance; it cannot enforce how callers connect to it.

## DB assignment

One Redis 7 HA pair is shared by cache and queue traffic, split by logical DB:

| DB  | Purpose       | Current consumers                                                                                                                                                                                                  |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0` | Cache         | None yet — no app in this repo does caching today.                                                                                                                                                                 |
| `1` | Queues        | `apps/workers` (BullMQ)                                                                                                                                                                                            |
| `2` | ERPNext cache | The ERPNext + Frappe Education plane (`infra/terraform/modules/erpnext`), staging/prod only. Frappe's own RQ cache, unrelated to DB `0` — a separate job system on a separate keyspace, not this repo's own cache. |
| `3` | ERPNext queue | Same plane, its bench worker/scheduler roles (RQ) — unrelated to DB `1`'s BullMQ queue, even though both are "queues": two different job systems that must never share keyspace.                                   |

Select the DB in the connection URL path: `rediss://:<token>@<host>:6379/0` for cache,
`.../1` for queues. Don't rely on the client default (DB 0) implicitly — state it in the URL so a
copy-pasted connection string can't silently land a queue consumer on the cache DB.

**`apps/realtime`'s pub/sub connection doesn't fit this table, and that's not an oversight.**
Redis `PUBLISH`/`SUBSCRIBE` are **not scoped by logical DB** — a channel published on DB 0 is
visible to a subscriber connected on DB 1. `SELECT` has no effect on pub/sub at all; this is a
Redis server property, not a client quirk. Logical DBs give you key-namespace isolation, not
channel isolation. Consequences:

- Putting `apps/realtime` on DB 0 or DB 1 doesn't isolate its channels from anything else. The
  actual isolation mechanism is the channel name itself — prefix every channel
  `apps/realtime` publishes or subscribes to (e.g. `realtime:<topic>`) so it can't collide with a
  key-eviction notification or a future cache-invalidation channel on the same server.
- Which DB number `apps/realtime` connects on is therefore an arbitrary choice, not a correctness
  one. Use `0` (same as cache) since it does no key traffic of its own and has nothing to isolate
  from the cache DB's keyspace.

## TLS

The instance rejects plaintext connections (`transit_encryption_mode = "required"` in the
Terraform module). Use the `rediss://` scheme, not `redis://`. `ioredis` (pinned at `5.10.1` in
`apps/workers` and `apps/realtime`) detects TLS from the URL scheme automatically — no `tls: {}`
option needs adding to `apps/workers/src/connection.ts` or `apps/realtime/src/connection.ts` for
this to work; the code as it exists today interoperates with a `rediss://` `REDIS_URL` without a
diff.

## AUTH token

The token lives in Secrets Manager, not in `REDIS_URL` as committed config. The module outputs
`redis_auth_secret_arn` (root) / `auth_secret_arn` (module); the secret's JSON value is
`{ auth_token, primary_endpoint, reader_endpoint, port, tls, cache_db, queue_db }`. Whatever
wires environment variables for a deployed service (no compute tier exists yet — see
`infra/terraform/README.md`) is responsible for assembling `REDIS_URL` from that secret at deploy
time, e.g.:

```
REDIS_URL=rediss://:${auth_token}@${primary_endpoint}:${port}/${queue_db}
```

Never write the AUTH token into a `*.tfvars` file, a `terraform output` consumed by CI logs, or a
`.env` file committed to the repo.

## Eviction policy: noeviction, instance-wide

`maxmemory-policy` is set to `noeviction` for the whole instance, not just the queue DB — **Redis
has no per-logical-DB eviction policy**, so "noeviction for queue DB" and "LRU eviction for cache
DB" cannot both be true on one instance. This is documented in
[`modules/redis/README.md`](../../infra/terraform/modules/redis/README.md) as a hard limit, not a
missing feature. `noeviction` is the correct choice for the whole instance because it's the only
one that's safe for queues: if BullMQ's job-state keys get evicted under memory pressure, jobs are
lost or corrupted silently. That constraint wins over cache convenience.

What this means for anything using DB 0 as a cache:

- **Set a TTL on every cache key** (`SET key value EX <seconds>` / `SETEX`). Without a policy that
  evicts under pressure, a cache entry only ever leaves Redis by expiring or by being explicitly
  deleted — it will not be reclaimed for space.
- **A full instance rejects writes** (`OOM command not allowed`) instead of silently dropping
  cache entries. Treat that as a page-worthy alarm (CloudWatch `DatabaseMemoryUsagePercentage` on
  the replication group), not a condition the cache is expected to absorb gracefully.
- If a workload genuinely needs LRU/LFU eviction under memory pressure — e.g. a
  cache with unbounded key growth and no natural TTL — it needs a second, separate Redis instance
  with its own `maxmemory-policy`, not a third logical DB on this one.

## Failover

The pair fails over automatically (`automatic_failover_enabled = true`, `multi_az_enabled =
true`). To exercise the dev acceptance criterion ("failover drill passes in dev"), see the
`aws elasticache test-failover` procedure in
[`modules/redis/README.md`](../../infra/terraform/modules/redis/README.md#running-the-dev-failover-drill).
`ioredis` reconnects through the replication group's DNS endpoint automatically; no client-side
retry logic is needed beyond what `apps/workers/src/connection.ts` and
`apps/realtime/src/connection.ts` already have.

## Known gaps (not covered by the `infra/terraform/modules/redis` ticket)

- `apps/api` has no Redis client at all today. If it's meant to read/write the cache DB, that's a
  separate, apps/api-scoped change — this doc doesn't invent one.
- No compute tier exists yet, so nothing in this repo currently sets `REDIS_URL` to point at the
  provisioned instance. The "API and workers connect over TLS" acceptance criterion can only be
  exercised manually (e.g. `redis-cli -h <endpoint> -p 6379 --tls -a <token>` from the bastion, or
  a one-off `ioredis` script pointed at `rediss://...`) until a compute module exists to wire the
  environment variable for real.
