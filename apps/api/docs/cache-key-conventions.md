# Cache key conventions

This document defines the naming standards and usage patterns for Redis cache keys in the API
layer (`apps/api`). For infra-level Redis conventions (DB assignment, TLS, eviction policy,
failover), see [`docs/runbooks/redis-conventions.md`](../../../docs/runbooks/redis-conventions.md).

## Key format

Every cache key is scoped to a tenant (school) using the prefix:

```
sch:{school_id}:{resource}:{id}:{subkey}
```

| Segment       | Purpose                                         | Example           |
| ------------- | ----------------------------------------------- | ----------------- |
| `sch`         | Literal prefix — identifies this as a cache key | `sch`             |
| `{school_id}` | Tenant boundary — isolates data per school      | `sch_abc123`      |
| `{resource}`  | The type of entity being cached                 | `session`, `user` |
| `{id}`        | Entity identifier                               | `usr_456`         |
| `{subkey}`    | Optional sub-key for fine-grained caching       | `tokens`, `prefs` |

### Examples

```
sch:sch_abc:session:usr_123              — user session data
sch:sch_abc:user:usr_456:profile         — user profile cache
sch:sch_abc:config:defaults              — school-wide configuration
sch:sch_abc:timetable:cls_789:week       — class timetable for a specific week
```

## Construction

Always use the `cacheKey()` function — never construct keys by string interpolation:

```typescript
import { cacheKey, getCache, setCache } from "../cache";

const key = cacheKey(schoolId, "session", userId);
await setCache(redis, key, sessionData, 3600); // 1 hour TTL
const cached = await getCache<SessionData>(redis, key);
```

The `cacheKey()` function returns a branded `CacheKey` type. Only keys produced by this function
are accepted by `getCache` / `setCache`. This is enforced at compile time — a raw string will
cause a TypeScript error:

```typescript
const raw: string = "sch:sch_abc:foo";
await getCache(redis, raw); // ❌ Type error: string is not assignable to CacheKey
```

## Rules

1. **Always use `cacheKey()`** — manual key construction is a type error and a latent bug.
2. **Always set a TTL** — the Redis instance uses `noeviction`. A key without a TTL will persist
   forever and eventually cause an OOM.
3. **No unbounded key growth** — if a resource set is unbounded (e.g., every API response), use
   a short TTL or a bounded key space.
4. **Tenant isolation** — the `schoolId` segment is the tenant boundary. Never skip it or use a
   shared prefix across tenants.

## Single-flight (dogpile protection)

When a cache key expires and multiple concurrent requests discover the miss simultaneously, only
one upstream query executes. All others wait for the same in-flight promise:

```typescript
import { cacheKey, getCache, setCache, singleFlight } from "../cache";

const key = cacheKey(schoolId, "user", userId);

const user = await singleFlight(key, async () => {
  const dbResult = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
  await setCache(redis, key, dbResult, 300); // 5 min TTL
  return dbResult;
});
```

Under 50 concurrent requests for the same expired key, only 1 database query fires. The
remaining 49 await the same promise. After the promise settles (success or failure), the
in-flight entry is cleaned up and the next miss triggers a fresh fetch.

## TTL guidelines

| Resource                 | Suggested TTL | Rationale                                     |
| ------------------------ | ------------- | --------------------------------------------- |
| Session data             | 3600 (1 h)    | Short enough to expire stale sessions         |
| User profile             | 300 (5 min)   | Changes infrequently but should refresh often |
| School config / defaults | 600 (10 min)  | Rarely changes, safe to cache longer          |
| Timetable                | 120 (2 min)   | Changes may be frequent during scheduling     |
| ERPNext data             | 120 (2 min)   | Synced from external system, short TTL safe   |

These are guidelines, not mandates. Adjust based on actual staleness tolerance.
