export type ErpNextFailureKind = "timeout" | "network" | "http";

export interface ErpNextResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 2_000;

function backoffDelayMs(attempt: number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ErpNextError extends Error {
  public readonly status: number;
  public readonly data: unknown;
  public readonly kind: ErpNextFailureKind;

  constructor(message: string, status: number, data: unknown, kind: ErpNextFailureKind = "http") {
    super(message);
    this.name = "ErpNextError";
    this.status = status;
    this.data = data;
    this.kind = kind;
  }
}

export function isTransientErpNextFailure(error: unknown): boolean {
  if (!(error instanceof ErpNextError)) return false;
  if (error.kind === "timeout" || error.kind === "network") return true;
  return error.status >= 500 || error.status === 429;
}

export class ErpNextClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly siteHost: string;
  private readonly timeout: number;

  constructor(options: { baseUrl: string; apiKey: string; siteHost: string; timeout?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.siteHost = options.siteHost;
    this.timeout = options.timeout ?? 30_000;
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<ErpNextResponse<T>> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ErpNextResponse<T>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.attempt<T>(method, path, body);
      } catch (error) {
        lastError = error;
        if (!isTransientErpNextFailure(error) || attempt === MAX_ATTEMPTS) throw error;
        await sleep(backoffDelayMs(attempt));
      }
    }

    throw lastError;
  }

  private async attempt<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ErpNextResponse<T>> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `token ${this.apiKey}`,
      "Content-Type": "application/json",
      Host: this.siteHost,
    };

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
      throw new ErpNextError(extractErrorMessage(data), response.status, data, "http");
    }

    return { data, status: response.status, headers: response.headers };
  }
}

function extractErrorMessage(data: unknown): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
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
