import type { RedisClient } from "./redis";

/**
 * A RedisClient that exists but cannot be used (ST-060), the Redis counterpart to
 * `db/unusable.ts`'s `createUnusableDatabase`.
 *
 * createApp mounts `/api/ai/*` only `if (database && redis && entitlements)` (see app.ts's AI
 * gate section), so anything that needs to see the whole route surface without a live cache —
 * today, only OpenAPI spec generation — has to pass something truthy or silently lose that entire
 * surface from the document. Two things rule out the obvious options:
 *
 *   - `null`, the previous behavior: satisfies no route that checks `if (redis)`, so `/api/ai/*`
 *     (and the rate limiter, idempotency, finance queues, …) never registers at all.
 *   - a real (even `lazyConnect: true`) `ioredis` instance: BullMQ's `Queue` constructor
 *     (`financeInvoiceRoutes`) duck-types its connection via `isRedisInstance` — `typeof
 *     obj.connect === 'function'`, etc. — then actually calls `connect()` on it once that check
 *     passes, regardless of `lazyConnect`. Verified by trying it: registration attempted a real
 *     TCP connect to `127.0.0.1:6379` and retried until killed.
 *
 * So this is a Proxy like `createUnusableDatabase`'s, but not throw-on-every-access: lifecycle
 * methods that route *registration* (not a served request) actually calls — `connect`,
 * `disconnect`, `quit`, `duplicate`, event-subscription methods, and the handful of properties
 * some client reads structurally (`options`, `status`, `isCluster`) — are inert no-ops instead of
 * traps, so registration proceeds exactly as it would against a real, connected client. Every
 * other property (`get`, `set`, `eval`, `defineCommand`, …) still throws: nothing during
 * registration sends an actual command, so reaching one of those means a real request was served
 * against this placeholder, which must fail loudly rather than reach for a socket.
 */
export function createUnusableRedis(): RedisClient {
  const reject = (name: string) => (): never => {
    throw new Error(
      `RedisClient.${name} was called on the unusable spec-generation placeholder ` +
        "(see src/redis-unusable.ts) — this must never happen outside route registration",
    );
  };

  const noop = () => undefined;
  const resolved = () => Promise.resolve();

  // A Map, not a plain object indexed by a dynamic key: same lookup, but doesn't read as an
  // object-injection sink to static analysis the way `record[prop]` would.
  const inert = new Map<string, unknown>([
    ["connect", resolved],
    ["disconnect", noop],
    ["quit", resolved],
    ["duplicate", () => createUnusableRedis()],
    ["on", noop],
    ["once", noop],
    ["off", noop],
    ["removeListener", noop],
    ["removeAllListeners", noop],
    ["setMaxListeners", noop],
    ["getMaxListeners", () => Infinity],
    // BullMQ's `RedisConnection.getRedisVersionAndType` (redis-connection.js) parses this itself
    // rather than sending a structured command — `INFO`'s reply is plain text — so a real,
    // modern, `noeviction` line is cheaper to fake than to special-case bypassing the check.
    ["info", () => Promise.resolve("redis_version:7.4.0\r\nmaxmemory_policy:noeviction\r\n")],
    ["options", {}],
    // 'ready' is the one ioredis status BullMQ's `RedisConnection.waitUntilReady` treats as an
    // immediate no-op return (redis-connection.js) — every other status either waits on a 'ready'
    // event this placeholder will never emit, or throws. Reported as already-ready sidesteps both.
    ["status", "ready"],
    ["isCluster", false],
  ]);

  // Every unlisted string property resolves to a function that throws once actually called, so an
  // unanticipated duck-type check (`typeof obj[x] === 'function'`) still passes. `then` is the one
  // property that must NOT do that: returning a function named `then` makes this object thenable,
  // so any bare `await unusableRedis` (not calling one of its methods, just awaiting the value
  // itself) reads it as a promise and invokes that function as an executor. Reported as `undefined`
  // instead, the same as a real ioredis client, which is not thenable either.
  const notThenable = new Set(["then", "catch", "finally"]);

  // Function target for the same reason `createUnusableDatabase` uses one (see db/unusable.ts):
  // some property-access site could otherwise trip a proxy-invariant TypeError instead of one of
  // the traps below. The body stays empty because it is unreachable — every access goes through
  // `get`/`apply` first.
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- unreachable Proxy target; the get/apply traps run first
  return new Proxy(function () {} as unknown as RedisClient, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (inert.has(prop)) return inert.get(prop);
      if (notThenable.has(prop)) return undefined;
      return reject(prop);
    },
    apply: reject("<call>"),
  });
}
