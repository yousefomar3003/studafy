import { createHash } from "node:crypto";

import { HTTPException } from "hono/http-exception";

import type { RedisClient } from "../redis";
import type { AppEnv } from "./requestId";
import type { MiddlewareHandler } from "hono";

/**
 * Redis-backed idempotency key middleware for financial and import POST endpoints.
 *
 * When a client sends an `Idempotency-Key` header on a POST request, this middleware:
 *
 * 1. Captures the handler's response (status, headers, body) and stores it in Redis
 *    keyed by the idempotency key, with a 24-hour TTL.
 * 2. On replay (same key + same body), returns the stored response verbatim.
 * 3. On body mismatch (same key, different body), rejects with 409 Conflict.
 * 4. On concurrent duplicates (same key, same body while first is in-flight), the
 *    second request awaits the first and returns the same result.
 *
 * Requests without the `Idempotency-Key` header or non-POST methods pass through
 * unmodified. When Redis is unavailable, the middleware passes through (fail-open).
 *
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header
 *
 * @example
 * ```typescript
 * app.use("/api/finance/*", idempotencyMiddleware({ redis, windowSeconds: 86400 }));
 * app.post("/api/finance/payments", ...); // protected
 * app.get("/api/finance/payments", ...);  // passes through
 * ```
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface IdempotencyOptions {
  /** Redis client. Pass `null` to disable idempotency (fail-open). */
  redis: RedisClient | null;
  /** TTL for stored responses in seconds. Defaults to 86400 (24 hours). */
  windowSeconds?: number;
}

// ---------------------------------------------------------------------------
// Stored response shape
// ---------------------------------------------------------------------------

interface StoredResponse {
  /** SHA-256 hex digest of the raw request body. */
  bodyHash: string;
  /** HTTP status code of the original response. */
  status: number;
  /** Response headers as a plain object. */
  headers: Record<string, string>;
  /** Serialized response body (text). */
  body: string;
}

// ---------------------------------------------------------------------------
// In-flight tracking (module-level, per-process)
// ---------------------------------------------------------------------------

interface InflightEntry {
  promise: Promise<StoredResponse>;
  bodyHash: string;
}

const inflight = new Map<string, InflightEntry>();

/**
 * Exposed for testing only. Clears all in-flight entries.
 */
export function resetIdempotencyInflight(): void {
  inflight.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY_PREFIX = "idem:";
const DEFAULT_WINDOW_SECONDS = 86_400; // 24 hours

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function redisKey(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

async function storeResponse(
  client: RedisClient,
  key: string,
  entry: StoredResponse,
  ttlSeconds: number,
): Promise<void> {
  await client.set(redisKey(key), JSON.stringify(entry), "EX", ttlSeconds);
}

async function getStoredResponse(client: RedisClient, key: string): Promise<StoredResponse | null> {
  const raw = await client.get(redisKey(key));
  if (raw === null) return null;
  return JSON.parse(raw) as StoredResponse;
}

function buildResponse(stored: StoredResponse): Response {
  return new Response(stored.body, {
    status: stored.status,
    headers: stored.headers,
  });
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Redis-backed idempotency key middleware.
 *
 * Only applies to POST requests carrying an `Idempotency-Key` header. All other
 * requests pass through unmodified. Fails open when Redis is unavailable.
 *
 * @param options  Configuration: Redis client, window TTL, and test seams.
 * @returns A Hono middleware handler.
 */
export function idempotencyMiddleware({
  redis,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
}: IdempotencyOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!redis) {
      await next();
      return;
    }

    // Only POST requests are idempotent by convention.
    if (c.req.method !== "POST") {
      await next();
      return;
    }

    const key = c.req.header("idempotency-key");
    if (!key) {
      await next();
      return;
    }

    // Read and hash the raw request body.
    const rawBody = await c.req.text();
    const bodyHash = hashBody(rawBody);

    // 1. Check Redis for a completed response.
    const stored = await getStoredResponse(redis, key);
    if (stored) {
      if (stored.bodyHash !== bodyHash) {
        throw new HTTPException(409, {
          message: "Idempotency key reused with a different request body",
        });
      }
      return buildResponse(stored);
    }

    // 2. Check in-flight map for a concurrent duplicate.
    const existing = inflight.get(key);
    if (existing) {
      if (existing.bodyHash !== bodyHash) {
        throw new HTTPException(409, {
          message: "Idempotency key reused with a different request body",
        });
      }
      // Await the in-flight request; its result will be stored in Redis.
      const result = await existing.promise;
      return buildResponse(result);
    }

    // 3. Register in-flight entry and let the handler process.
    let resolve!: (value: StoredResponse) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<StoredResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    inflight.set(key, { promise, bodyHash });

    try {
      await next();

      // Capture the response before it's consumed.
      const res = c.res.clone();
      const responseBody = await res.text();
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });

      const entry: StoredResponse = {
        bodyHash,
        status: res.status,
        headers: responseHeaders,
        body: responseBody,
      };

      // Store in Redis and resolve the in-flight promise.
      await storeResponse(redis, key, entry, windowSeconds);
      resolve(entry);

      // Rebuild the response for the current request since c.res may have been consumed.
      c.res = buildResponse(entry);
    } catch (err) {
      reject(err);
      throw err;
    } finally {
      inflight.delete(key);
    }
  };
}
