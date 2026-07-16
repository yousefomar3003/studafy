import type { SupportedLocale } from "../middleware/locale";

/**
 * ERPNext HTTP client placeholder.
 *
 * This module provides a basic HTTP client wrapper for ERPNext API calls.
 * It forwards the Accept-Language header to receive translated system errors.
 *
 * TODO: Implement actual ERPNext API endpoints when the integration is built.
 *
 * @example
 * ```typescript
 * const client = new ErpNextClient({
 *   baseUrl: process.env.ERPNEXT_URL,
 *   apiKey: process.env.ERPNEXT_API_KEY,
 * });
 *
 * // Headers are automatically forwarded
 * const result = await client.get("/api/resource/Student", {
 *   locale: "ar",
 *   acceptLanguage: "ar,en;q=0.9",
 * });
 * ```
 */

export interface ErpNextClientOptions {
  /** Base URL for ERPNext API (e.g., "https://erp.example.com") */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
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
  /** Response data */
  data: T;
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Headers;
}

/**
 * ERPNext HTTP client with header forwarding.
 *
 * Forwards Accept-Language header to ERPNext to receive translated system errors.
 * All responses are parsed and error messages are extracted for localization.
 */
export class ErpNextClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;

  constructor(options: ErpNextClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.timeout = options.timeout ?? 30000;
  }

  /**
   * Make a GET request to ERPNext.
   */
  async get<T = unknown>(
    path: string,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.request<T>("GET", path, undefined, options);
  }

  /**
   * Make a POST request to ERPNext.
   */
  async post<T = unknown>(
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.request<T>("POST", path, body, options);
  }

  /**
   * Make a PUT request to ERPNext.
   */
  async put<T = unknown>(
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.request<T>("PUT", path, body, options);
  }

  /**
   * Make a DELETE request to ERPNext.
   */
  async delete<T = unknown>(
    path: string,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    return this.request<T>("DELETE", path, undefined, options);
  }

  /**
   * Make an HTTP request to ERPNext with header forwarding.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: ErpNextRequestOptions,
  ): Promise<ErpNextResponse<T>> {
    const url = `${this.baseUrl}${path}`;

    // Build headers with Accept-Language forwarding
    const headers: Record<string, string> = {
      Authorization: `token ${this.apiKey}`,
      "Content-Type": "application/json",
      ...options?.headers,
    };

    // Forward Accept-Language header for translated errors
    if (options?.acceptLanguage) {
      headers["Accept-Language"] = options.acceptLanguage;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Parse response
      let data: T;
      const contentType = response.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/json")) {
        data = (await response.json()) as T;
      } else {
        data = (await response.text()) as T;
      }

      // Handle ERPNext errors
      if (!response.ok) {
        const errorMessage = this.extractErrorMessage(data);
        throw new ErpNextError(errorMessage, response.status, data);
      }

      return {
        data,
        status: response.status,
        headers: response.headers,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof ErpNextError) {
        throw error;
      }
      throw new ErpNextError(
        error instanceof Error ? error.message : "Unknown ERPNext error",
        500,
        null,
      );
    }
  }

  /**
   * Extract error message from ERPNext response.
   */
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
 * ERPNext-specific error class.
 */
export class ErpNextError extends Error {
  public readonly status: number;
  public readonly data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = "ErpNextError";
    this.status = status;
    this.data = data;
  }
}
