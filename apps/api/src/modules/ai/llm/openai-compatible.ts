/**
 * Wire format for OpenAI-compatible chat-completion providers (Together AI and the like).
 *
 * {@link AnthropicProvider} owns everything that is the same for every provider — timeout, retry,
 * circuit breaker, secret scrubbing, SSE framing — and calls into these pure functions for the parts
 * that differ: the request path and headers, the request body, and how a response or stream chunk
 * is read. Selected with `AI_LLM_PROVIDER=openai-compatible`; see
 * docs/runbooks/anthropic-provider-config.md.
 *
 * ## Reasoning
 *
 * Hybrid reasoning models (Qwen 3.5, for one) think before answering by default, and those tokens
 * count against `max_tokens`. Every surface's token ceiling was sized for a direct answer, so the
 * request turns reasoning off (`reasoning.enabled: false`, Together's toggle; providers without the
 * toggle ignore it). Any reasoning that still comes back — a separate `reasoning` field, or a
 * `<think>` block a provider leaves inline — is never returned as the answer.
 *
 * ## Privacy
 *
 * No user identifier is sent. The Anthropic format's `metadata.user_id` exists for that provider's
 * abuse monitoring; an OpenAI-compatible host has no equivalent agreement behind its `user` field.
 */

import type { LlmGenerateInput, LlmUsage } from "./provider";

export const OPENAI_COMPATIBLE_PATH = "/chat/completions";

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface OpenAiChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: OpenAiUsage | null;
}

export interface OpenAiStreamChunk {
  model?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: OpenAiUsage | null;
  error?: { message?: string };
}

export function openAiHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

export function openAiRequestBody(
  input: LlmGenerateInput,
  maxTokens: number,
  stream: boolean,
): Record<string, unknown> {
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: input.prompt });
  return {
    model: input.model,
    max_tokens: maxTokens,
    messages,
    stream,
    // Without this an OpenAI-compatible stream never reports token usage.
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    reasoning: { enabled: false },
  };
}

export function openAiUsage(usage: OpenAiUsage | null | undefined): LlmUsage {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** Drop any inline `<think>…</think>` block a reasoning model left in front of its answer. */
export function stripReasoning(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
}

export function openAiResponseText(response: OpenAiChatResponse): string {
  return stripReasoning(response.choices?.[0]?.message?.content ?? "");
}

export function openAiStopReason(response: OpenAiChatResponse): string | null {
  return response.choices?.[0]?.finish_reason ?? null;
}
