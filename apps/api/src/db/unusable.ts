import type { Database } from "./client";

/**
 * A Database that exists but cannot be used (ST-060).
 *
 * createApp mounts the ERPNext webhook only `if (database)`, so anything that needs to see the whole
 * route surface without a database — spec generation, and the webhook's pre-database failure tests —
 * has to pass something truthy or silently lose a real endpoint from the document. Passing a real
 * client would mean opening a connection just to draw a picture of the routes.
 *
 * Every property access throws. That is the safety: these callers only ever *register* handlers or
 * exercise paths that return before touching the database, so if that assumption ever stops holding,
 * this fails loudly at the first query instead of quietly reaching for a socket.
 *
 * `if (database)` does not trip the trap — ToBoolean never reads a property.
 */
export function createUnusableDatabase(): Database {
  const reject = (): never => {
    throw new Error(
      "this Database is a placeholder (see src/db/unusable.ts) and must never be queried",
    );
  };

  // The target is a function so `apply` is a legal trap: postgres.js clients are callable (the
  // sql`...` tagged template), and a plain object target would make that access throw a TypeError
  // about proxy invariants rather than this error. The body stays empty because it is unreachable —
  // every call goes through the apply trap above and throws before the target would run.
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- unreachable Proxy target; the apply trap throws first
  return new Proxy(function () {} as unknown as Database, { get: reject, apply: reject });
}
