import { CircuitOpenError } from "../../../lib/circuit-breaker";
import { scrubSecret } from "../../../lib/scrub-secret";
import { redactPayload } from "../../../middleware/auditEmitter";

import type { CircuitBreaker } from "../../../lib/circuit-breaker";
import type { Logger } from "../../../logger";

/**
 * Anthropic LLM provider (ST-164).
 *
 * The only place in the app that talks to the LLM plane. It mirrors the ERPNext client's shape
 * deliberately — same failure taxonomy, same retry policy, same circuit-breaker boundary — so the
 * two outbound HTTP planes agree on what "a failure" means and when to back off.
 *
 * ## Failure taxonomy
 *
 * {@link LlmProviderError.kind} distinguishes the three things that can go wrong, because a retry
 * policy needs three different answers: a timeout (`kind: "timeout"`, synthesized status 504), a
 * network failure (`kind: "network"`, 503), and an HTTP verdict from the provider (`kind: "http"`,
 * the real status). {@link isTransientLlmFailure} is the shared predicate both this provider and
 * its circuit breaker use, so they cannot drift: timeouts, network failures, 5xx, and 429 are
 * transient; 4xx is a verdict from a healthy provider and is never retried.
 *
 * ## Retry policy
 *
 * Up to {@link AI_LLM_MAX_ATTEMPTS} total attempts with exponential backoff and full jitter, the
 * same policy the ERPNext client uses. The circuit breaker wraps the whole retry loop, keyed per
 * school, so one school's provider outage does not fail another's requests.
 *
 * ## Streaming
 *
 * `stream()` is the provider-level SSE surface — tested here, but not yet exposed over HTTP. The
 * future chat route will consume it; it is intentionally not a route today because the ST-155 gate
 * releases its quota hold when a handler returns, which races an SSE body that is still streaming
 * (see docs/rag/llm-gateway-and-model-routing.md). A stream fails fast: mid-stream errors surface
 * as a thrown {@link LlmProviderError} from the generator, and a truncated stream still yields a
 * final `done` event carrying what it received.
 *
 * ## Zero retention
 *
 * Zero-retention is a workspace-level agreement with the provider, not a per-request header (the
 * one header some clients send is undocumented and rejected with 400). The honest implementation:
 * when {@link AnthropicProviderOptions.zeroRetention} is true, the `metadata.user_id` field — the
 * one field the provider retains for abuse monitoring — is never sent. See
 * docs/runbooks/anthropic-provider-config.md.
 *
 * ## Secrets
 *
 * The API key is a header, never a URL parameter, so it cannot leak through a logged URL. Beyond
 * that, error payloads are run through the audit redactor and then scrubbed for any literal
 * occurrence of the key itself, because the provider echoes request context into some error bodies.
 * Nothing in this module logs `apiKey`.
 */

export const AI_LLM_MAX_ATTEMPTS = 3;
export const AI_LLM_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
export const AI_LLM_API_VERSION = "2023-06-01";
export const AI_LLM_DEFAULT_TIMEOUT_MS = 60_000;
export const AI_LLM_DEFAULT_MAX_TOKENS = 4096;
const LLM_BASE_BACKOFF_MS = 200;
const LLM_MAX_BACKOFF_MS = 2_000;

export type LlmFailureKind =
  /** The client's own AbortController fired. */
  | "timeout"
  /** DNS, connection refused, TLS, socket reset — the request never got an answer. */
  | "network"
  /** The provider answered with a non-2xx status. */
  | "http"
  /** The breaker refused to call at all. */
  | "circuit_open";

export interface LlmUsage {
  /** Input tokens (prompt + any cached prefix), as reported by the provider. */
  inputTokens: number;
  /** Output tokens, as reported by the provider. */
  outputTokens: number;
  /** input + output; the cost the route commits to quota. */
  totalTokens: number;
}

export interface LlmGenerateInput {
  /** The model id to call, already resolved through the routing table. */
  model: string;
  /** The user's prompt. */
  prompt: string;
  /** Optional system hint, sent as the request's `system` field. */
  system?: string;
  /** Output-token ceiling for this call; defaults to the provider's configured ceiling. */
  maxTokens?: number;
  /**
   * Sent as `metadata.user_id` unless the deployment is zero-retention. The provider retains this
   * field for abuse monitoring; omitting it is the zero-retention posture.
   */
  userId?: string;
  /** Breaker key — one circuit per school. Omitted when no breaker is wired in. */
  circuitKey?: string;
}

export interface LlmGeneration {
  /** The assembled text response. */
  content: string;
  /** The model that actually answered. */
  model: string;
  /** Tokens the provider reported for this generation; the cost the route commits to quota. */
  usage: LlmUsage;
  stopReason: string | null;
}

export type LlmStreamEvent =
  | { type: "delta"; delta: string; text: string }
  | { type: "done"; text: string; usage: LlmUsage; stopReason: string | null; model: string };

export interface LlmProvider {
  generate(input: LlmGenerateInput): Promise<LlmGeneration>;
  stream(input: LlmGenerateInput): AsyncGenerator<LlmStreamEvent, void, unknown>;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Override the Anthropic API endpoint (gateway/proxy). Defaults to the public API. */
  baseUrl?: string;
  /** Whole-call timeout: connect + wait + read. Default 60s. */
  timeoutMs?: number;
  /** Server default for `max_tokens` when a request omits it. Default 4096. */
  defaultMaxTokens?: number;
  /** Zero-retention posture: never send `metadata.user_id` when true. Default false. */
  zeroRetention?: boolean;
  circuitBreaker?: CircuitBreaker;
  logger?: Logger;
  /** Injected in tests so retry backoff does not make the suite sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests so the provider does not need a live network. */
  fetch?: typeof globalThis.fetch;
}

/** True when a failure is worth another attempt — and, separately, worth counting toward opening the circuit. */
export function isTransientLlmFailure(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return false;
  if (!(error instanceof LlmProviderError)) return false;
  if (error.kind === "timeout" || error.kind === "network") return true;
  return error.status >= 500 || error.status === 429;
}

function backoffDelayMs(attempt: number): number {
  const ceiling = Math.min(LLM_MAX_BACKOFF_MS, LLM_BASE_BACKOFF_MS * 2 ** (attempt - 1));
  // Full jitter rather than a fixed exponential: several API tasks that failed against the same
  // outage would otherwise retry in lockstep and hit the recovering provider as a thundering herd.
  return Math.random() * ceiling;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * LLM-specific error.
 *
 * `status` is the HTTP status when the provider answered, and a synthesized one when it did not:
 * 504 for a timeout, 503 for a network failure or an open circuit. Read {@link kind} rather than
 * inferring the cause from the status.
 */
export class LlmProviderError extends Error {
  public readonly kind: LlmFailureKind;
  public readonly status: number;
  public readonly data: unknown;

  constructor(
    message: string,
    status: number,
    kind: LlmFailureKind,
    data?: unknown,
    secret?: string,
  ) {
    // The message can carry provider-echoed request context, so it is scrubbed on the same terms
    // as the payload.
    super(secret ? (scrubSecret(message, secret) as string) : message);
    this.name = "LlmProviderError";
    this.status = status;
    this.kind = kind;
    this.data = data;
  }
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicMessageResponse {
  model: string;
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
  usage?: Partial<AnthropicUsage>;
}

interface AnthropicStreamEvent {
  type: string;
  message?: { model?: string; usage?: Partial<AnthropicUsage> };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: Partial<AnthropicUsage>;
  error?: { type?: string; message?: string };
}

function usageFrom(usage: Partial<AnthropicUsage> | undefined): LlmUsage {
  const inputTokens =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0);
  const outputTokens = usage?.output_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function extractText(response: AnthropicMessageResponse): string {
  return (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function extractErrorMessage(data: unknown): string {
  if (data && typeof data === "object") {
    const obj = data as { error?: unknown; message?: unknown };
    if (obj.error && typeof obj.error === "object") {
      const err = obj.error as { message?: unknown };
      if (typeof err.message === "string") return err.message;
    }
    if (typeof obj.message === "string") return obj.message;
  }
  return "AI provider error";
}

export function createAnthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  return new AnthropicProvider(options);
}

export class AnthropicProvider implements LlmProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly defaultMaxTokens: number;
  private readonly zeroRetention: boolean;
  private readonly circuitBreaker: CircuitBreaker | undefined;
  private readonly logger: Logger | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? AI_LLM_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? AI_LLM_DEFAULT_TIMEOUT_MS;
    this.defaultMaxTokens = options.defaultMaxTokens ?? AI_LLM_DEFAULT_MAX_TOKENS;
    this.zeroRetention = options.zeroRetention ?? false;
    this.circuitBreaker = options.circuitBreaker;
    this.logger = options.logger?.child({ component: "ai-llm-provider" });
    this.sleep = options.sleep ?? defaultSleep;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async generate(input: LlmGenerateInput): Promise<LlmGeneration> {
    const attemptAll = async (): Promise<LlmGeneration> => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= AI_LLM_MAX_ATTEMPTS; attempt += 1) {
        try {
          return await this.attemptGenerate(input);
        } catch (error) {
          lastError = error;
          if (!isTransientLlmFailure(error) || attempt === AI_LLM_MAX_ATTEMPTS) throw error;

          const delay = backoffDelayMs(attempt);
          this.logger?.warn(
            {
              model: input.model,
              attempt,
              max_attempts: AI_LLM_MAX_ATTEMPTS,
              delay_ms: Math.round(delay),
              kind: error instanceof LlmProviderError ? error.kind : "unknown",
              status: error instanceof LlmProviderError ? error.status : undefined,
            },
            "AI generation failed; retrying",
          );
          await this.sleep(delay);
        }
      }

      throw lastError;
    };

    if (!this.circuitBreaker) return attemptAll();

    try {
      return await this.circuitBreaker.execute(input.circuitKey ?? "default", attemptAll);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new LlmProviderError(
          "The AI provider is unreachable; requests are paused while it recovers",
          503,
          "circuit_open",
        );
      }
      throw error;
    }
  }

  async *stream(input: LlmGenerateInput): AsyncGenerator<LlmStreamEvent, void, unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: { ...this.headers(), accept: "text/event-stream" },
        body: JSON.stringify(this.body(input, true)),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      throw this.transportError(error, controller, input);
    }
    clearTimeout(timeoutId);

    if (!response.ok) throw await this.httpError(response);
    if (!response.body) {
      throw new LlmProviderError("AI provider returned an empty stream", 503, "network");
    }

    yield* this.readSse(response.body);
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": AI_LLM_API_VERSION,
      "content-type": "application/json",
    };
  }

  private body(input: LlmGenerateInput, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens ?? this.defaultMaxTokens,
      messages: [{ role: "user", content: input.prompt }],
      stream,
    };
    if (input.system) body.system = input.system;
    // Zero retention is a workspace-level agreement, not a per-request header. When a deployment
    // opts in, the one field the provider retains for abuse monitoring is never sent.
    if (!this.zeroRetention && input.userId) {
      body.metadata = { user_id: input.userId };
    }
    return body;
  }

  private async attemptGenerate(input: LlmGenerateInput): Promise<LlmGeneration> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.body(input, false)),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      throw this.transportError(error, controller, input);
    }
    clearTimeout(timeoutId);

    if (!response.ok) throw await this.httpError(response);

    let data: AnthropicMessageResponse;
    try {
      data = (await response.json()) as AnthropicMessageResponse;
    } catch {
      throw new LlmProviderError("AI provider returned an unreadable response", 503, "network");
    }

    const usage = usageFrom(data.usage);
    return {
      content: extractText(data),
      model: data.model,
      usage,
      stopReason: data.stop_reason ?? null,
    };
  }

  /** Distinguish a timeout (our own abort) from a network failure, like the ERPNext client. */
  private transportError(
    error: unknown,
    controller: AbortController,
    input: LlmGenerateInput,
  ): LlmProviderError {
    const aborted =
      controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    return aborted
      ? new LlmProviderError(`AI generation timed out after ${this.timeoutMs}ms`, 504, "timeout")
      : new LlmProviderError(
          error instanceof Error ? error.message : "AI generation failed",
          503,
          "network",
        );
  }

  private async httpError(response: Response): Promise<LlmProviderError> {
    let data: unknown;
    const contentType = response.headers.get("Content-Type") ?? "";
    try {
      data = contentType.includes("json") ? await response.json() : await response.text();
    } catch {
      data = null;
    }
    return new LlmProviderError(
      extractErrorMessage(data),
      response.status,
      "http",
      this.sanitize(data),
      this.apiKey,
    );
  }

  /**
   * Redact known-sensitive keys, then scrub any literal copy of our own credential. The provider
   * echoes parts of the request into some error bodies, so key-name redaction alone is not enough.
   */
  private sanitize(data: unknown): unknown {
    const redacted =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? redactPayload(data as Record<string, unknown>)
        : data;
    return scrubSecret(redacted, this.apiKey);
  }

  /**
   * Parse the provider's SSE stream. Text deltas are yielded as they arrive; usage and stop reason
   * are accumulated from `message_start` and `message_delta` and carried on the final `done` event.
   */
  private async *readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<LlmStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | null = null;
    let model: string | null = null;
    let finished = false;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const raw = dataLine.slice("data:".length).trim();
          if (!raw) continue;

          let payload: AnthropicStreamEvent;
          try {
            payload = JSON.parse(raw) as AnthropicStreamEvent;
          } catch {
            continue;
          }

          if (payload.type === "error") {
            const message = payload.error?.message ?? "AI provider stream error";
            throw new LlmProviderError(message, 500, "http", payload.error, this.apiKey);
          }
          if (payload.type === "message_start") {
            inputTokens = usageFrom(payload.message?.usage).inputTokens;
            model = payload.message?.model ?? model;
          } else if (payload.type === "content_block_delta") {
            const delta = payload.delta?.type === "text_delta" ? (payload.delta.text ?? "") : "";
            if (delta) {
              text += delta;
              yield { type: "delta", delta, text };
            }
          } else if (payload.type === "message_delta") {
            // message_delta.usage.output_tokens is the cumulative running total.
            outputTokens = usageFrom(payload.usage).outputTokens;
            stopReason = payload.delta?.stop_reason ?? stopReason;
          } else if (payload.type === "message_stop") {
            finished = true;
            yield {
              type: "done",
              text,
              usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
              stopReason,
              model: model ?? "unknown",
            };
          }
        }
      }

      // A truncated stream (no message_stop) still yields what it received.
      if (!finished) {
        yield {
          type: "done",
          text,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
          stopReason,
          model: model ?? "unknown",
        };
      }
    } finally {
      reader.releaseLock();
    }
  }
}
