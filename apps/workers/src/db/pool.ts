/**
 * Postgres pools for the workers process.
 *
 * Every job processor used to open its own `postgres()` pool and `end()` it in a `finally`, so each
 * job paid a fresh TCP + TLS + auth handshake (through the Supabase transaction pooler, a new client
 * connection there too) for what is usually two or three short transactions. Under a burst of
 * notification jobs that was hundreds of connection set-ups a minute, all of it overhead.
 *
 * Instead the process holds one primary pool (and one read pool, when a separate read database is
 * configured) for its whole life, created lazily on the first job and closed on shutdown
 * (`closeWorkerPools`, called from index.ts). Processors are handed the pool; they never end it.
 *
 * Processors still accept a connection string as well (`DatabaseSource`): tests point them at a
 * disposable database that way, and a string means "open a dedicated pool for this call and close
 * it afterwards" — exactly the previous behaviour, so every existing test seam keeps working.
 *
 * Pools that deliberately stay separate from this one:
 * - index.ts's polling loops (outbox relay, entitlement invalidator, email dispatcher) and the
 *   billing-pipeline metrics scrape: long-lived already, and kept apart so a burst of jobs can never
 *   make a latency-sensitive loop or a scrape wait for a connection (and vice versa).
 * - billing/worker.ts's batch-invoice run: it holds a tenant transaction across each ERPNext call
 *   with 10-way concurrency, and its own `max: 2` pool is what bounds that to two connections. On
 *   the shared pool it could pin most of it for minutes. The job is rare (one per manual batch), so
 *   the per-job handshake costs nothing that matters.
 */

import postgres from "postgres";

import { databaseUrlFrom, readDatabaseUrlFrom } from "../env";

import type { Env } from "../env";
import type { Sql } from "postgres";

export interface PoolOptions {
  /** Maximum connections. Connections open lazily, so this is a ceiling, not a reservation. */
  max?: number;
  /** PEM CA bundle; when set, TLS verifies the server against it (see env.ts DATABASE_CA_CERT). */
  databaseCaCert?: string;
}

/**
 * Size of the process-wide primary pool.
 *
 * Every transaction a processor runs is short (no network call inside one — the batch-invoice run,
 * which does, keeps its own pool), and each job holds at most one connection at a time, so ten
 * covers the notifications queue's concurrency of 10 and lets the rarer queues share the slack;
 * anything beyond that queues in postgres.js for a few milliseconds rather than opening yet another
 * pooler client. Ten is also comfortably inside the Supabase transaction pooler's per-database
 * backend pool, leaving room for the API and the polling loops.
 */
export const WORKER_DB_POOL_MAX = 10;

/** The read pool only serves report rendering (concurrency 3). */
export const WORKER_READ_DB_POOL_MAX = 3;

/**
 * Build a pool with the options every worker pool shares. `prepare: false` is mandatory: the
 * runtime sits behind a transaction pooler (Supabase / PgBouncer), where a server-side prepared
 * statement does not survive from one transaction to the next.
 */
export function createPool(url: string, options: PoolOptions = {}): Sql {
  return postgres(url, {
    max: options.max ?? 2,
    idle_timeout: 20,
    prepare: false,
    ...(options.databaseCaCert
      ? { ssl: { ca: options.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });
}

/**
 * The database a processor runs on: a pool it borrows (production: the process-wide pool) or a
 * connection string it opens a dedicated pool for and closes when done (tests, one-off scripts).
 */
export type DatabaseSource = string | Sql;

export interface DatabaseLease {
  sql: Sql;
  /** Ends the pool when this lease opened it; a no-op for a borrowed pool. */
  release(): Promise<void>;
}

export function leaseDatabase(source: DatabaseSource, options: PoolOptions = {}): DatabaseLease {
  if (typeof source !== "string") {
    return { sql: source, release: () => Promise.resolve() };
  }
  const sql = createPool(source, options);
  return { sql, release: () => sql.end({ timeout: 5 }) };
}

/** `leaseDatabase` around one callback. */
export async function withDatabase<T>(
  source: DatabaseSource,
  fn: (sql: Sql) => Promise<T>,
  options: PoolOptions = {},
): Promise<T> {
  const lease = leaseDatabase(source, options);
  try {
    return await fn(lease.sql);
  } finally {
    await lease.release();
  }
}

let primaryPool: Sql | null = null;
let readPool: Sql | null = null;

/**
 * The process-wide primary pool. Lazy, so importing the registry (registry.test.ts does) creates
 * nothing; postgres.js would not connect until the first query anyway, but nothing is built at all.
 */
export function workerPool(env: Env): Sql {
  primaryPool ??= createPool(databaseUrlFrom(env), {
    max: WORKER_DB_POOL_MAX,
    databaseCaCert: env.DATABASE_CA_CERT,
  });
  return primaryPool;
}

/**
 * The process-wide read pool for report rendering. The primary pool itself when no separate read
 * database is configured (readDatabaseUrlFrom falls back to the primary URL), so that case opens
 * no extra connections.
 */
export function workerReadPool(env: Env): Sql {
  const url = readDatabaseUrlFrom(env);
  if (url === databaseUrlFrom(env)) return workerPool(env);
  readPool ??= createPool(url, {
    max: WORKER_READ_DB_POOL_MAX,
    databaseCaCert: env.DATABASE_CA_CERT,
  });
  return readPool;
}

/** Close the process-wide pools. Called once, from index.ts's shutdown, after jobs have drained. */
export async function closeWorkerPools(): Promise<void> {
  const pools = [primaryPool, readPool].filter((pool): pool is Sql => pool !== null);
  primaryPool = null;
  readPool = null;
  await Promise.all(pools.map((pool) => pool.end({ timeout: 5 })));
}
