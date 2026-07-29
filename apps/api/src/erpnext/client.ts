/**
 * ERPNext HTTP client.
 *
 * Every call into the ERPNext plane goes through here: site provisioning, company bootstrap, and
 * the ST-119 finance gateway. It forwards Accept-Language so ERPNext returns its own validation
 * messages in the caller's language, and it is the only place in the app that talks to an external
 * HTTP service with a timeout, a retry policy, and a circuit breaker.
 *
 * ## Why failures are classified
 *
 * The original version collapsed every non-HTTP failure — including the AbortError its own timeout
 * raises — into `status: 500`. That is a lie a retry policy cannot work with: "the request timed
 * out", "the host is unreachable", and "ERPNext returned 500" need three different answers, and
 * only two of them should count toward opening the circuit. {@link ErpNextError.kind} is that
 * distinction, and {@link ErpNextError.status} now reports 504 for a timeout and 503 for a network
 * failure rather than flattening both.
 *
 * ## What is retried
 *
 * Timeouts, network failures, 5xx, and 429 — up to {@link MAX_ATTEMPTS} total attempts, with
 * exponential backoff and full jitter. **4xx is never retried.** A 400 from ERPNext is a
 * validation verdict destined for the Fee Structure Builder; retrying it would delay the user's
 * error message and, worse, could double-apply a request ERPNext had actually accepted.
 *
 * ## Secrets
 *
 * The API key is a header, never a URL parameter, so it cannot leak through a logged URL. Beyond
 * that, {@link ErpNextError} payloads are run through the audit redactor and then scrubbed for any
 * literal occurrence of the key itself, because ERPNext echoes request context into some error
 * bodies. Nothing in this module logs `apiKey`.
 */

import { redactPayload } from "../middleware/auditEmitter";

import { CircuitOpenError } from "./circuit-breaker";

import type { CircuitBreaker } from "./circuit-breaker";
import type { Logger } from "../logger";
import type { SupportedLocale } from "../middleware/locale";

/** Total attempts, not retries: 1 initial + 2 retries. */
export const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2_000;

export type ErpNextFailureKind =
  /** The client's own AbortController fired. */
  | "timeout"
  /** DNS, connection refused, TLS, socket reset — the request never got an answer. */
  | "network"
  /** ERPNext answered with a non-2xx status. */
  | "http"
  /** The breaker refused to call at all. */
  | "circuit_open";

export interface ErpNextClientOptions {
  /** Base URL for ERPNext API (e.g., "https://erp.example.com") */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /**
   * Breaker key — one circuit per ERPNext site. The finance gateway passes the school id; callers
   * that share the global site (provisioning, bootstrap) can leave it at the default.
   */
  circuitKey?: string;
  circuitBreaker?: CircuitBreaker;
  logger?: Logger;
  /** Injected in tests so retry backoff does not make the suite sleep for real. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ErpNextRequestOptions {
  /** Locale for translated error messages */
  locale?: SupportedLocale;
  /** Original Accept-Language header value to forward */
  acceptLanguage?: string;
  /** Additional headers to include */
  headers?: Record<string, string>;
}

export interface ErpNextResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
}

/**
 * True when a failure is worth another attempt — and, separately, worth counting toward opening
 * the circuit. Exported because the breaker is constructed outside this module and needs the same
 * predicate, so the two cannot drift.
 */
export function isTransientErpNextFailure(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return false;
  if (!(error instanceof ErpNextError)) return false;
  if (error.kind === "timeout" || error.kind === "network") return true;
  return error.status >= 500 || error.status === 429;
}

function backoffDelayMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  // Full jitter rather than a fixed exponential: several API tasks that failed against the same
  // outage would otherwise retry in lockstep and hit the recovering site as a thundering herd.
  return Math.random() * ceiling;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Replace every literal occurrence of a secret, at any depth, with a marker. */
function scrubSecret(value: unknown, secret: string): unknown {
  if (secret.length === 0) return value;
  if (typeof value === "string") {
    return value.includes(secret) ? value.split(secret).join("[REDACTED]") : value;
  }
  if (Array.isArray(value)) return value.map((item) => scrubSecret(item, secret));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubSecret(nested, secret);
    }
    return out;
  }
  return value;
}

export class ErpNextClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;
  private readonly circuitKey: string;
  private readonly circuitBreaker: CircuitBreaker | undefined;
  private readonly logger: Logger | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ErpNextClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.timeout = options.timeout ?? 30000;
    this.circuitKey = options.circuitKey ?? "default";
    this.circuitBreaker = options.circuitBreaker;
    this.logger = options.logger?.child({ component: "erpnext-client" });
    this.sleep = options.sleep ?? defaultSleep;
  }

  async get<T = unknown>(
    path: string,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.request<T>("GET", path, undefined, options);
  }

  async post<T = unknown>(
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.request<T>("POST", path, body, options);
  }

  async put<T = unknown>(
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.request<T>("PUT", path, body, options);
  }

  async delete<T = unknown>(
    path: string,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.request<T>("DELETE", path, undefined, options);
  }

  /** Retry loop. The breaker wraps the whole loop, so one open circuit costs one rejection. */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    const attemptAll = async (): Promise<ErpNextResponse<T>> => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          return await this.attempt<T>(method, path, body, options);
        } catch (error) {
          lastError = error;
          if (!isTransientErpNextFailure(error) || attempt === MAX_ATTEMPTS) throw error;

          const delay = backoffDelayMs(attempt);
          this.logger?.warn(
            {
              method,
              path,
              attempt,
              max_attempts: MAX_ATTEMPTS,
              delay_ms: Math.round(delay),
              kind: error instanceof ErpNextError ? error.kind : "unknown",
              status: error instanceof ErpNextError ? error.status : undefined,
            },
            "ERPNext request failed; retrying",
          );
          await this.sleep(delay);
        }
      }

      throw lastError;
    };

    if (!this.circuitBreaker) return attemptAll();

    try {
      return await this.circuitBreaker.execute(this.circuitKey, attemptAll);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new ErpNextError(
          "ERPNext is unreachable; requests are paused while it recovers",
          503,
          null,
          "circuit_open",
        );
      }
      throw error;
    }
  }

  /** One HTTP attempt. Every throw from here is an ErpNextError with an accurate `kind`. */
  private async attempt<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `token ${this.apiKey}`,
      "Content-Type": "application/json",
      ...options?.headers,
    };

    if (options?.acceptLanguage) {
      headers["Accept-Language"] = options.acceptLanguage;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      // Distinguishing these two is the whole point: an abort is our own timeout firing, anything
      // else out of fetch is the network. Both are transient; neither is "ERPNext returned 500".
      const aborted =
        controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      throw aborted
        ? new ErpNextError(
            `ERPNext request timed out after ${this.timeout}ms`,
            504,
            null,
            "timeout",
          )
        : new ErpNextError(
            error instanceof Error ? error.message : "ERPNext request failed",
            503,
            null,
            "network",
          );
    } finally {
      clearTimeout(timeoutId);
    }

    let data: T;
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      data = (await response.json()) as T;
    } else {
      data = (await response.text()) as T;
    }

    if (!response.ok) {
      throw new ErpNextError(
        this.extractErrorMessage(data),
        response.status,
        this.sanitize(data),
        "http",
        this.apiKey,
      );
    }

    return { data, status: response.status, headers: response.headers };
  }

  /**
   * Redact known-sensitive keys, then scrub any literal copy of our own credential. ERPNext echoes
   * parts of the request into some error bodies, so key-name redaction alone is not enough.
   */
  private sanitize(data: unknown): unknown {
    const redacted =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? redactPayload(data as Record<string, unknown>)
        : data;
    return scrubSecret(redacted, this.apiKey);
  }

  private extractErrorMessage(data: unknown): string {
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      // ERPNext error format: { "exc_type": "...", "message": "..." }
      if (typeof obj.message === "string") {
        return obj.message;
      }
      if (typeof obj._server_messages === "string") {
        try {
          const messages = JSON.parse(obj._server_messages) as string[];
          return messages[0] ?? "ERPNext error";
        } catch {
          return "ERPNext error";
        }
      }
    }
    return "ERPNext error";
  }
}

/**
 * ERPNext-specific error.
 *
 * `status` is the HTTP status when ERPNext answered, and a synthesized one when it did not: 504 for
 * a timeout, 503 for a network failure or an open circuit. Read {@link kind} rather than inferring
 * the cause from the status.
 */
export class ErpNextError extends Error {
  public readonly status: number;
  public readonly data: unknown;
  public readonly kind: ErpNextFailureKind;

  constructor(
    message: string,
    status: number,
    data: unknown,
    kind: ErpNextFailureKind = "http",
    secret?: string,
  ) {
    // The message comes from ERPNext and can carry echoed request context, so it is scrubbed on
    // the same terms as the payload.
    super(secret ? (scrubSecret(message, secret) as string) : message);
    this.name = "ErpNextError";
    this.status = status;
    this.data = data;
    this.kind = kind;
  }
}
