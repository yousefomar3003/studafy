/**
 * Per-school ERPNext client construction (ST-119).
 *
 * `ErpNextClient` is credential- and site-agnostic; this binds one to a tenant. Two things happen
 * here that cannot happen inside the client:
 *
 *   1. The Host header is set to the school's Frappe site name, which is what selects the tenant's
 *      site behind the shared ERPNext frontend. Getting this wrong does not fail loudly — it
 *      succeeds against the *wrong tenant's* data. That is why {@link TenantErpNext} wraps the
 *      client rather than returning it: there is no call path that reaches ERPNext without the
 *      header, because the raw client never leaves this module.
 *   2. The circuit key is the school id, so one school's outage does not fail requests for
 *      another. They are separate Frappe sites that merely share a hostname.
 */

import { ErpNextClient, isTransientErpNextFailure } from "../../../erpnext/client";
import {
  InMemoryCircuitBreaker,
  RedisCircuitBreaker,
  type CircuitBreaker,
} from "../../../lib/circuit-breaker";

import type { ErpNextCredentialResolver } from "./credential-resolver";
import type { ErpNextRequestOptions, ErpNextResponse } from "../../../erpnext/client";
import type { Logger } from "../../../logger";
import type { RedisClient } from "../../../redis";
import type { TransactionSql } from "postgres";

/** A client already bound to one school's site. Every request carries the tenant Host header. */
export class TenantErpNext {
  private readonly client: ErpNextClient;
  private readonly siteHost: string;

  constructor(client: ErpNextClient, siteHost: string) {
    this.client = client;
    this.siteHost = siteHost;
  }

  private withSite(options?: ErpNextRequestOptions): ErpNextRequestOptions {
    // Host last so a caller cannot override it by passing their own headers.
    return { ...options, headers: { ...options?.headers, Host: this.siteHost } };
  }

  get<T = unknown>(path: string, options?: ErpNextRequestOptions): Promise<ErpNextResponse<T>> {
    return this.client.get<T>(path, this.withSite(options));
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.client.post<T>(path, body, this.withSite(options));
  }

  put<T = unknown>(
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.client.put<T>(path, body, this.withSite(options));
  }
}

export interface TenantErpNextFactoryOptions {
  resolver: ErpNextCredentialResolver;
  logger: Logger;
  /** Absent in local/test configurations; the breaker then degrades to per-process state. */
  redis?: RedisClient | null;
  timeout?: number;
}

/**
 * Builds tenant-bound clients off one shared breaker.
 *
 * The breaker is constructed once and reused, which is the point: a breaker rebuilt per request
 * would have no memory and could never open. It is given the same transience predicate the client
 * uses for retries, so the two agree on what "a failure" means — notably that a 4xx is a verdict
 * from a healthy ERPNext and must not count toward opening the circuit.
 */
export class TenantErpNextFactory {
  private readonly resolver: ErpNextCredentialResolver;
  private readonly logger: Logger;
  private readonly breaker: CircuitBreaker;
  private readonly timeout: number | undefined;

  constructor(options: TenantErpNextFactoryOptions) {
    this.resolver = options.resolver;
    this.logger = options.logger;
    this.timeout = options.timeout;
    this.breaker = options.redis
      ? new RedisCircuitBreaker(options.redis, options.logger, {
          // Preserve the key shape and log component the ERPNext breaker used before the generic
          // extraction, so an already-open circuit survives a deploy without resetting.
          keyPrefix: "cb:erpnext",
          component: "erpnext-circuit-breaker",
          isFailure: isTransientErpNextFailure,
        })
      : new InMemoryCircuitBreaker({ isFailure: isTransientErpNextFailure });
  }

  async forSchool(tx: TransactionSql, schoolId: string): Promise<TenantErpNext> {
    const credentials = await this.resolver.resolve(tx, schoolId);

    const client = new ErpNextClient({
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      timeout: this.timeout,
      circuitKey: schoolId,
      circuitBreaker: this.breaker,
      logger: this.logger,
    });

    return new TenantErpNext(client, credentials.siteHost);
  }
}
