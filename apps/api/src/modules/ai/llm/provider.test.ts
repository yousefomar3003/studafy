// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { CircuitOpenError } from "../../../lib/circuit-breaker";

import {
  AnthropicProvider,
  AI_LLM_API_VERSION,
  AI_LLM_DEFAULT_BASE_URL,
  AI_LLM_MAX_ATTEMPTS,
  createAnthropicProvider,
  isTransientLlmFailure,
  LlmProviderError,
} from "./provider";

import type { LlmGenerateInput } from "./provider";
import type { CircuitBreaker } from "../../../lib/circuit-breaker";

const API_KEY = "sk-ant-test-1234567890";
const MODEL = "claude-3-5-haiku-20241022";

function jsonResponse(data: unknown, init: { status: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(data), {
    status: init.status,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function okGeneration() {
  return jsonResponse(
    {
      id: "msg_1",
      model: MODEL,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "The answer is 42." }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    { status: 200 },
  );
}

function stubFetch(getResponse: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return getResponse();
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

function providerWith(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return createAnthropicProvider({
    apiKey: API_KEY,
    fetch,
    sleep: async () => undefined,
    ...overrides,
  });
}

const GENERATE_INPUT: LlmGenerateInput = {
  model: MODEL,
  prompt: "What is the meaning of life?",
};

describe("AnthropicProvider.generate request shape", () => {
  test("posts to /messages with the Anthropic headers and a streamless body", async () => {
    const { fetch, calls } = stubFetch(okGeneration);
    const provider = providerWith(fetch);

    await provider.generate({
      ...GENERATE_INPUT,
      system: "Be concise.",
      maxTokens: 64,
      userId: "user-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${AI_LLM_DEFAULT_BASE_URL}/messages`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      "x-api-key": API_KEY,
      "anthropic-version": AI_LLM_API_VERSION,
      "content-type": "application/json",
    });

    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      model: MODEL,
      max_tokens: 64,
      stream: false,
      system: "Be concise.",
      messages: [{ role: "user", content: "What is the meaning of life?" }],
      metadata: { user_id: "user-1" },
    });
  });

  test("sends metadata.user_id by default and omits it under zero retention", async () => {
    const defaultCalls = stubFetch(okGeneration);
    await providerWith(defaultCalls.fetch).generate({ ...GENERATE_INPUT, userId: "user-1" });
    expect(JSON.parse(String(defaultCalls.calls[0].init.body)).metadata.user_id).toBe("user-1");

    const zeroRetentionCalls = stubFetch(okGeneration);
    await providerWith(zeroRetentionCalls.fetch, { zeroRetention: true }).generate({
      ...GENERATE_INPUT,
      userId: "user-1",
    });
    expect(JSON.parse(String(zeroRetentionCalls.calls[0].init.body)).metadata).toBeUndefined();
  });

  test("strips a trailing slash from a custom base URL", async () => {
    const { fetch, calls } = stubFetch(okGeneration);
    await providerWith(fetch, { baseUrl: "https://proxy.example.com/v1/" }).generate(
      GENERATE_INPUT,
    );
    expect(calls[0].url).toBe("https://proxy.example.com/v1/messages");
  });
});

describe("AnthropicProvider.generate success path", () => {
  test("returns assembled text, the serving model, usage, and stop reason", async () => {
    const { fetch } = stubFetch(okGeneration);
    const provider = providerWith(fetch);

    const generation = await provider.generate(GENERATE_INPUT);

    expect(generation.content).toBe("The answer is 42.");
    expect(generation.model).toBe(MODEL);
    expect(generation.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(generation.stopReason).toBe("end_turn");
  });

  test("counts cached tokens in input usage", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        {
          model: MODEL,
          content: [{ type: "text", text: "ok" }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 6,
            cache_read_input_tokens: 4,
            output_tokens: 5,
          },
        },
        { status: 200 },
      ),
    );
    const generation = await providerWith(fetch).generate(GENERATE_INPUT);
    expect(generation.usage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
  });
});

describe("AnthropicProvider.generate failure taxonomy", () => {
  test("retries a transient 5xx up to the attempt budget, then surfaces the last error", async () => {
    let calls = 0;
    const { fetch } = stubFetch(() => {
      calls += 1;
      return calls < AI_LLM_MAX_ATTEMPTS
        ? jsonResponse({ error: { type: "overloaded_error", message: "busy" } }, { status: 529 })
        : okGeneration();
    });
    const generation = await providerWith(fetch).generate(GENERATE_INPUT);

    expect(calls).toBe(AI_LLM_MAX_ATTEMPTS);
    expect(generation.content).toBe("The answer is 42.");
  });

  test("never retries a 4xx", async () => {
    let calls = 0;
    const { fetch } = stubFetch(() => {
      calls += 1;
      return jsonResponse(
        { error: { type: "invalid_request_error", message: "bad model" } },
        { status: 400 },
      );
    });

    const error = await providerWith(fetch)
      .generate(GENERATE_INPUT)
      .catch((e) => e);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.kind).toBe("http");
    expect(error.status).toBe(400);
  });

  test("classifies an AbortError as a timeout", async () => {
    const { fetch } = stubFetch(() => {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      throw err;
    });

    const error = await providerWith(fetch)
      .generate(GENERATE_INPUT)
      .catch((e) => e);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.kind).toBe("timeout");
    expect(error.status).toBe(504);
  });

  test("classifies a thrown fetch error as a network failure", async () => {
    const { fetch } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });

    const error = await providerWith(fetch)
      .generate(GENERATE_INPUT)
      .catch((e) => e);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.kind).toBe("network");
    expect(error.status).toBe(503);
  });

  test("scrubs the API key from a provider-echoed error payload", async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            type: "authentication_error",
            message: `invalid x-api-key: ${API_KEY} is not valid`,
          },
        },
        { status: 401 },
      ),
    );

    const error = await providerWith(fetch)
      .generate(GENERATE_INPUT)
      .catch((e) => e);

    expect(error.message).not.toContain(API_KEY);
    expect(JSON.stringify(error.data)).not.toContain(API_KEY);
  });

  test("an open circuit surfaces as 503 circuit_open without calling the provider", async () => {
    let called = false;
    const { fetch, calls } = stubFetch(() => {
      called = true;
      return okGeneration();
    });
    const openBreaker: CircuitBreaker = {
      async execute() {
        throw new CircuitOpenError("school");
      },
      async state() {
        return "open";
      },
    };

    const error = await providerWith(fetch, { circuitBreaker: openBreaker })
      .generate({ ...GENERATE_INPUT, circuitKey: "school" })
      .catch((e) => e);

    expect(called).toBe(false);
    expect(calls).toHaveLength(0);
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.kind).toBe("circuit_open");
    expect(error.status).toBe(503);
  });
});

describe("isTransientLlmFailure", () => {
  test("true for timeouts, network failures, 5xx, and 429", () => {
    expect(isTransientLlmFailure(new LlmProviderError("t", 504, "timeout"))).toBe(true);
    expect(isTransientLlmFailure(new LlmProviderError("n", 503, "network"))).toBe(true);
    expect(isTransientLlmFailure(new LlmProviderError("5", 500, "http"))).toBe(true);
    expect(isTransientLlmFailure(new LlmProviderError("r", 429, "http"))).toBe(true);
  });

  test("false for a 4xx verdict and for an open circuit", () => {
    expect(isTransientLlmFailure(new LlmProviderError("r", 400, "http"))).toBe(false);
    expect(isTransientLlmFailure(new CircuitOpenError("school"))).toBe(false);
    expect(isTransientLlmFailure(new Error("boom"))).toBe(false);
  });
});

describe("AnthropicProvider.stream", () => {
  function sseStream(events: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("yields text deltas and a final done event with accumulated usage", async () => {
    const { fetch } = stubFetch(() =>
      sseStream([
        `event: message_start\ndata: {"type":"message_start","message":{"model":"${MODEL}","usage":{"input_tokens":10}}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n`,
        `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5},"delta":{"stop_reason":"end_turn"}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ]),
    );
    const provider = providerWith(fetch);

    const events = [];
    for await (const event of provider.stream(GENERATE_INPUT)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "delta", delta: "Hello", text: "Hello" },
      { type: "delta", delta: " world", text: "Hello world" },
      {
        type: "done",
        text: "Hello world",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        stopReason: "end_turn",
        model: MODEL,
      },
    ]);
  });

  test("a truncated stream still yields done with what it received", async () => {
    const { fetch } = stubFetch(() =>
      sseStream([
        `data: {"type":"message_start","message":{"model":"${MODEL}","usage":{"input_tokens":10}}}\n\n`,
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n`,
      ]),
    );

    const events = [];
    for await (const event of providerWith(fetch).stream(GENERATE_INPUT)) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "done",
      text: "partial",
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
    });
  });

  test("an error event mid-stream throws", async () => {
    const { fetch } = stubFetch(() =>
      sseStream([
        `data: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n`,
      ]),
    );

    const provider = providerWith(fetch);
    const error = await (async () => {
      for await (const _event of provider.stream(GENERATE_INPUT)) {
        // no-op
      }
    })().catch((e) => e);

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.status).toBe(500);
  });
});

describe("AnthropicProvider module surface", () => {
  test("createAnthropicProvider returns an AnthropicProvider", () => {
    const { fetch } = stubFetch(okGeneration);
    expect(providerWith(fetch)).toBeInstanceOf(AnthropicProvider);
  });
});
