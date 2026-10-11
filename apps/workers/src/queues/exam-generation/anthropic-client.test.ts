// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  AnthropicClientError,
  createAnthropicClient,
  isTransientAnthropicFailure,
} from "./anthropic-client";

const API_KEY = "sk-ant-test-1234567890";
const MODEL = "claude-3-5-haiku-20241022";

function jsonResponse(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(getResponse: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return getResponse();
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

describe("AnthropicClient.generate", () => {
  test("posts to /messages with the Anthropic headers and returns text + usage", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse(
        {
          model: MODEL,
          content: [{ type: "text", text: "the exam item bank" }],
          usage: { input_tokens: 100, output_tokens: 40 },
        },
        200,
      ),
    );
    const client = createAnthropicClient({ apiKey: API_KEY, fetch });

    const result = await client.generate({
      model: MODEL,
      system: "system prompt",
      prompt: "user prompt",
      maxTokens: 2048,
    });

    expect(result.content).toBe("the exam item bank");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: MODEL, max_tokens: 2048, system: "system prompt" });
  });

  test("throws AnthropicClientError with kind 'http' on a non-2xx response", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ error: { message: "bad request" } }, 400));
    const client = createAnthropicClient({ apiKey: API_KEY, fetch });

    await expect(client.generate({ model: MODEL, system: "s", prompt: "p" })).rejects.toThrow(
      AnthropicClientError,
    );
  });

  test("throws kind 'network' when fetch itself rejects", async () => {
    const fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const client = createAnthropicClient({ apiKey: API_KEY, fetch });

    try {
      await client.generate({ model: MODEL, system: "s", prompt: "p" });
      throw new Error("expected generate() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AnthropicClientError);
      expect((error as AnthropicClientError).kind).toBe("network");
    }
  });
});

describe("AnthropicClient.generate with apiFormat: openai-compatible", () => {
  const QWEN = "Qwen/Qwen3.5-9B";

  test("requires a baseUrl", () => {
    expect(() =>
      createAnthropicClient({ apiKey: API_KEY, apiFormat: "openai-compatible" }),
    ).toThrow(/baseUrl/);
  });

  test("posts a chat completion and returns the answer without any <think> block", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse(
        {
          model: QWEN,
          choices: [{ message: { content: '<think>hmm</think>\n{"items":[]}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 40 },
        },
        200,
      ),
    );
    const client = createAnthropicClient({
      apiKey: API_KEY,
      apiFormat: "openai-compatible",
      baseUrl: "https://api.together.xyz/v1/",
      fetch,
    });

    const result = await client.generate({
      model: QWEN,
      system: "sys",
      prompt: "go",
      maxTokens: 900,
    });

    expect(result).toEqual({
      content: '{"items":[]}',
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    });
    expect(calls[0]!.url).toBe("https://api.together.xyz/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: QWEN,
      max_tokens: 900,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
      ],
      reasoning: { enabled: false },
    });
  });

  test("json: true turns on the host's JSON mode", async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "{}" } }] }, 200),
    );
    const client = createAnthropicClient({
      apiKey: API_KEY,
      apiFormat: "openai-compatible",
      baseUrl: "https://api.together.xyz/v1",
      fetch,
    });

    await client.generate({ model: QWEN, system: "s", prompt: "p", json: true });

    expect(JSON.parse(calls[0]!.init.body as string).response_format).toEqual({
      type: "json_object",
    });
  });

  test("keeps the failure taxonomy", async () => {
    const { fetch } = stubFetch(() => jsonResponse({ error: { message: "busy" } }, 503));
    const client = createAnthropicClient({
      apiKey: API_KEY,
      apiFormat: "openai-compatible",
      baseUrl: "https://api.together.xyz/v1",
      fetch,
    });

    const error = await client.generate({ model: QWEN, system: "s", prompt: "p" }).catch((e) => e);

    expect(error).toBeInstanceOf(AnthropicClientError);
    expect(error.message).toBe("busy");
    expect(isTransientAnthropicFailure(error)).toBe(true);
  });
});

describe("isTransientAnthropicFailure", () => {
  test("treats timeout, network, 5xx and 429 as transient", () => {
    expect(isTransientAnthropicFailure(new AnthropicClientError("x", 504, "timeout"))).toBe(true);
    expect(isTransientAnthropicFailure(new AnthropicClientError("x", 503, "network"))).toBe(true);
    expect(isTransientAnthropicFailure(new AnthropicClientError("x", 500, "http"))).toBe(true);
    expect(isTransientAnthropicFailure(new AnthropicClientError("x", 429, "http"))).toBe(true);
  });

  test("treats a 4xx verdict from a healthy provider as non-transient", () => {
    expect(isTransientAnthropicFailure(new AnthropicClientError("x", 400, "http"))).toBe(false);
    expect(isTransientAnthropicFailure(new AnthropicClientError("x", 401, "http"))).toBe(false);
  });

  test("treats a non-AnthropicClientError as non-transient", () => {
    expect(isTransientAnthropicFailure(new Error("boom"))).toBe(false);
  });
});
