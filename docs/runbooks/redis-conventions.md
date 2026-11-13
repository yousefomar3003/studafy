# Redis usage conventions

Production's Redis is a Redis Cloud database (`eu-central-1`, `noeviction`, AOF every second;
[`infra/fly/README.md`](../../infra/fly/README.md)). This doc is the conventions apps must follow to
use it correctly — the provider runs the instance; it cannot enforce how callers connect to it.

## DB assignment

The design splits cache and queue traffic by logical DB:

| DB  | Purpose       | Current consumers                                                                                                                                                                                         |
| --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0` | Cache         | None yet — no app in this repo does caching today.                                                                                                                                                        |
| `1` | Queues        | `apps/workers` (BullMQ)                                                                                                                                                                                   |
| `2` | ERPNext cache | The ERPNext + Frappe Education plane (local `db/compose.yml`; not deployed on fly). Frappe's own RQ cache, unrelated to DB `0` — a separate job system on a separate keyspace, not this repo's own cache. |
| `3` | ERPNext queue | Same plane, its bench worker/scheduler roles (RQ) — unrelated to DB `1`'s BullMQ queue, even though both are "queues": two different job systems that must never share keyspace.                          |

Select the DB in the connection URL path: `rediss://:<token>@<host>:<port>/0` for cache,
`.../1` for queues. Don't rely on the client default (DB 0) implicitly — state it in the URL so a
copy-pasted connection string can't silently land a queue consumer on the cache DB.

**In production the split does not apply today:** the deploy workflow stages one `REDIS_URL` secret
onto api, workers and realtime (and the same value as realtime's `AUTH_REDIS_URL`), so all three
share whichever logical DB that URL names. Key prefixes (below) and BullMQ's own `bull:` prefix keep
the families apart.

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

Production's `REDIS_URL` is a `rediss://` URL (`infra/fly/README.md#secrets`). Use the `rediss://`
scheme, not `redis://`. `ioredis` (pinned at `5.10.1` in
`apps/workers` and `apps/realtime`) detects TLS from the URL scheme automatically — no `tls: {}`
option needs adding to `apps/workers/src/connection.ts` or `apps/realtime/src/connection.ts` for
this to work; the code as it exists today interoperates with a `rediss://` `REDIS_URL` without a
diff.

## Credentials

The Redis Cloud password is part of `REDIS_URL`, a secret in the `prod` GitHub Environment that the
deploy workflow copies onto the fly apps ([`secrets-conventions.md`](secrets-conventions.md)). Never
write it into committed config or a `.env` file in the repo.

## Eviction policy: noeviction, instance-wide

The Redis Cloud database's eviction policy is `noeviction` for the whole instance, not just the
queue DB — **Redis has no per-logical-DB eviction policy**, so "noeviction for queue DB" and "LRU
eviction for cache DB" cannot both be true on one instance. This is a hard limit, not a missing
feature. `noeviction` is the correct choice for the whole instance because it's the only
one that's safe for queues: if BullMQ's job-state keys get evicted under memory pressure, jobs are
lost or corrupted silently. That constraint wins over cache convenience.

What this means for anything using DB 0 as a cache:

- **Set a TTL on every cache key** (`SET key value EX <seconds>` / `SETEX`). Without a policy that
  evicts under pressure, a cache entry only ever leaves Redis by expiring or by being explicitly
  deleted — it will not be reclaimed for space.
- **A full instance rejects writes** (`OOM command not allowed`) instead of silently dropping
  cache entries. Treat that as a page-worthy condition (no alert on it is defined yet; Redis Cloud's
  console shows memory usage), not a condition the cache is expected to absorb gracefully.
- If a workload genuinely needs LRU/LFU eviction under memory pressure — e.g. a
  cache with unbounded key growth and no natural TTL — it needs a second, separate Redis instance
  with its own `maxmemory-policy`, not a third logical DB on this one.

## Key namespaces on DB 0

Every key family in use, so a new one can be checked against the list before it is added. All of
these carry a TTL, per the `noeviction` constraint above.

| Prefix                           | Owner                                                               | TTL       | Notes                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sch:{schoolId}:…`               | `apps/api/src/cache.ts`                                             | Varies    | The tenant-scoped default. `cacheKey()` is the only way to build one, and the branded `CacheKey` type is what enforces that.                                                   |
| `auth:jti:denylist:{jti}`        | `apps/api/src/modules/auth/denylist.ts`                             | Token exp | Not `sch:`-prefixed on purpose: a `jti` is globally unique, and revocation is checked before any tenant context exists.                                                        |
| `auth:oauth:state:{state}`       | `apps/api/src/modules/auth/oauth/state-store.ts`                    | 300s      | OAuth PKCE verifier + nonce between a flow's start and its callback. Single-use (`GETDEL`). No tenant exists yet at login/activation, hence not `sch:`-prefixed.               |
| `rl:{scope}:{identity}:{window}` | `apps/api/src/config/rateLimits.ts`                                 | Window    | Fails open — a Redis outage must not block traffic.                                                                                                                            |
| `cb:erpnext:{key}:{f\|o\|p}`     | `apps/api/src/erpnext/circuit-breaker.ts`                           | Varies    | Circuit-breaker state per upstream.                                                                                                                                            |
| `ent:{schoolId}`                 | `apps/api/src/modules/subscriptions/entitlements/cache.ts` (ST-133) | 300s      | School entitlement. Value is `<version>\|<json>`; a bodyless `<version>\|` is an invalidation floor. Written by compare-and-set Lua.                                           |
| `ent:ai:{studentId}`             | Same                                                                | 300s      | One student's AI entitlement. Not school-prefixed, so it cannot be `SCAN`-invalidated by a school change — the entry carries a `schoolVersion` the reader revalidates instead. |
| `sch:{schoolId}:flags:{name}`    | `apps/api/src/modules/flags/service.ts` (ST-277)                    | 10s       | One school's cached verdict for one flag, written via `cacheKey()`. The TTL is the propagation bound for a flipped per-tenant override: <30s without a deploy.                 |

The two `ent:` families are deliberately outside the `sch:` namespace: the ticket specifies those
key names exactly, and `cacheKey()` cannot produce them. See the header comment in
`entitlements/cache.ts` for why widening `cacheKey()` was rejected rather than done.

The `flags:` family rides inside `sch:` on purpose: a flag verdict is never meaningful outside its
school, so the tenant-scoped default (`cacheKey()`) is the correct and only builder.

## Failover

Redis Cloud is managed; failover and persistence are the provider's. No failover runbook is defined
for it. `ioredis` reconnects automatically; no client-side retry logic is needed beyond what
`apps/workers/src/connection.ts` and `apps/realtime/src/connection.ts` already have.

## Known gaps

- **One logical DB in production.** api, workers and realtime share one `REDIS_URL` (see "DB
  assignment"), so the cache/queue DB split is not in effect.
- **No alert on memory usage.** With `noeviction`, a full instance rejects writes, including
  BullMQ's.
