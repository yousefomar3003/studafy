// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingRateLimitError,
  createEmbeddingStage,
  createFallbackEmbeddingStage,
  createMockEmbeddingProvider,
  createOpenAiCompatibleEmbeddingProvider,
  parseEmbeddingVectors,
} from "./embedding";

import type { EmbeddingProvider } from "./embedding";
import type { MaterialChunk } from "./types";

const VECTOR = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => index / 10_000);

const chunk = (chunkIndex: number, content: string): MaterialChunk => ({
  chunkIndex,
  content,
  pageNumber: null,
  sectionTitle: null,
});

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const vectorsFor = (count: number) => ({
  data: Array.from({ length: count }, (_, index) => ({ index, embedding: VECTOR })),
});

describe("createOpenAiCompatibleEmbeddingProvider", () => {
  test("embeds a batch on OpenRouter at 1536 dimensions from hosts that keep no data", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: vectorsFor(2) }]);
    const provider = createOpenAiCompatibleEmbeddingProvider({
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-embedding-001",
      fetch: impl,
    });

    const vectors = await provider.embed(["البناء الضوئي", "Mitochondria"]);

    expect(provider.model).toBe("google/gemini-embedding-001@1536");
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(calls[0]!.body).toEqual({
      model: "google/gemini-embedding-001",
      input: ["البناء الضوئي", "Mitochondria"],
      dimensions: EMBEDDING_DIMENSIONS,
      provider: { data_collection: "deny" },
    });
    expect(vectors).toHaveLength(2);
    expect(vectors[0]!.startsWith("[0,0.0001,")).toBe(true);
  });

  test("a 429 is a rate limit the stage retries", async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, body: {} },
      { status: 200, body: vectorsFor(1) },
    ]);
    const provider = createOpenAiCompatibleEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      fetch: impl,
    });
    expect(provider.embed(["x"])).rejects.toBeInstanceOf(EmbeddingRateLimitError);

    const { impl: retrying } = fakeFetch([
      { status: 429, body: {} },
      { status: 200, body: vectorsFor(1) },
    ]);
    const stage = createEmbeddingStage(
      createOpenAiCompatibleEmbeddingProvider({
        apiKey: "k",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "m",
        fetch: retrying,
      }),
      { sleep: async () => undefined },
    );
    const result = await stage.embed([chunk(0, "x")]);
    expect(result.chunks[0]!.embeddingModel).toBe("m@1536");
    expect(calls).toHaveLength(1);
  });

  test("any other HTTP error throws at once", async () => {
    const { impl } = fakeFetch([{ status: 500, body: {} }]);
    const provider = createOpenAiCompatibleEmbeddingProvider({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      fetch: impl,
    });
    expect(provider.embed(["x"])).rejects.toThrow("HTTP 500");
  });
});

describe("parseEmbeddingVectors", () => {
  test("rejects a short, misshapen or non-finite answer", () => {
    expect(() => parseEmbeddingVectors(vectorsFor(1), 2)).toThrow("1 vectors for 2 inputs");
    expect(() => parseEmbeddingVectors({ data: [{ index: 0, embedding: [1] }] }, 1)).toThrow(
      "malformed",
    );
    const broken = [...VECTOR];
    broken[0] = Number.POSITIVE_INFINITY;
    expect(() => parseEmbeddingVectors({ data: [{ index: 0, embedding: broken }] }, 1)).toThrow(
      "malformed",
    );
  });
});

describe("createFallbackEmbeddingStage", () => {
  test("stores mock vectors under the mock's model when the live provider fails", async () => {
    const down: EmbeddingProvider = {
      model: "live@1536",
      embed: async () => {
        throw new Error("provider down");
      },
    };
    const errors: unknown[] = [];
    const stage = createFallbackEmbeddingStage(
      createEmbeddingStage(down),
      createEmbeddingStage(createMockEmbeddingProvider()),
      (error) => errors.push(error),
    );

    const result = await stage.embed([chunk(0, "a"), chunk(1, "b")]);

    expect(errors).toHaveLength(1);
    expect(result.chunks.map((c) => c.embeddingModel)).toEqual([EMBEDDING_MODEL, EMBEDDING_MODEL]);
  });

  test("uses the live provider when it works", async () => {
    const live: EmbeddingProvider = {
      model: "live@1536",
      embed: async (texts) => texts.map(() => `[${VECTOR.join(",")}]`),
    };
    const stage = createFallbackEmbeddingStage(
      createEmbeddingStage(live),
      createEmbeddingStage(createMockEmbeddingProvider()),
      () => undefined,
    );
    const result = await stage.embed([chunk(0, "a")]);
    expect(result.chunks[0]!.embeddingModel).toBe("live@1536");
  });
});
