/**
 * A small, worker-local Anthropic chat-completion client (ST-171).
 *
 * `apps/workers` has never made an LLM chat call before -- its one existing AI queue
 * (`ai-ingestion`) only does OCR/chunking/embeddings, which is a different provider and shape
 * entirely. Rather than extract `apps/api/src/modules/ai/llm/provider.ts` (with its circuit
 * breaker, streaming support, and secret-scrubbing helpers) into a new shared package, this is a
 * small, sized-to-what-the-worker-needs parallel implementation: non-streaming only, no circuit
 * breaker (BullMQ's own per-job `attempts` + exponential backoff is the retry unit for a queued
 * job, the same way every other worker queue in this codebase already relies on job-level retry
 * rather than an in-process breaker).
 *
 * This follows the precedent `apps/workers/src/log.ts`'s `WorkerLogger` already set for exactly
 * this "does a second service need apps/api's infra" question: its header comment explains that
 * extracting a shared logging package was deliberately left as a follow-up ticket rather than a
 * side effect of the feature that first needed it. See docs/rag/exam-mode.md.
 */

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 8192;

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AnthropicGenerateInput {
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface AnthropicGeneration {
  content: string;
  usage: AnthropicUsage;
}

/** True when the failure is worth a retry -- surfaced so the worker can decide whether to rethrow. */
export type AnthropicFailureKind = "timeout" | "network" | "http";

export class AnthropicClientError extends Error {
  readonly kind: AnthropicFailureKind;
  readonly status: number;

  constructor(message: string, status: number, kind: AnthropicFailureKind) {
    super(message);
    this.name = "AnthropicClientError";
    this.status = status;
    this.kind = kind;
  }
}

/** Transient failures are the ones worth a BullMQ retry: timeouts, network errors, 5xx, and 429. */
export function isTransientAnthropicFailure(error: unknown): boolean {
  if (!(error instanceof AnthropicClientError)) return false;
  if (error.kind === "timeout" || error.kind === "network") return true;
  return error.status >= 500 || error.status === 429;
}

export interface AnthropicClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface AnthropicMessageResponse {
  model: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function usageFrom(usage: AnthropicMessageResponse["usage"]): AnthropicUsage {
  const inputTokens = usage?.input_tokens ?? 0;
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
    const obj = data as { error?: { message?: unknown } };
    if (obj.error && typeof obj.error.message === "string") return obj.error.message;
  }
  return "AI provider error";
}

export function createAnthropicClient(options: AnthropicClientOptions) {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function generate(input: AnthropicGenerateInput): Promise<AnthropicGeneration> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: input.system,
          messages: [{ role: "user", content: input.prompt }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      const aborted =
        controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      throw aborted
        ? new AnthropicClientError(`AI generation timed out after ${timeoutMs}ms`, 504, "timeout")
        : new AnthropicClientError(
            error instanceof Error ? error.message : "AI generation failed",
            503,
            "network",
          );
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      throw new AnthropicClientError(extractErrorMessage(data), response.status, "http");
    }

    let data: AnthropicMessageResponse;
    try {
      data = (await response.json()) as AnthropicMessageResponse;
    } catch {
      throw new AnthropicClientError("AI provider returned an unreadable response", 503, "network");
    }

    return { content: extractText(data), usage: usageFrom(data.usage) };
  }

  return { generate };
}

export type AnthropicClient = ReturnType<typeof createAnthropicClient>;
