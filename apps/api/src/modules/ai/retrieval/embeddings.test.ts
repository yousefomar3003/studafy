import { AI_EMBEDDING_DIMENSIONS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  createOpenAiCompatibleQueryEmbedder,
  embedForSearch,
  parseEmbeddingResponse,
} from "./embeddings";

import type { QueryEmbedder } from "./embeddings";

const VECTOR = Array.from({ length: AI_EMBEDDING_DIMENSIONS }, (_, index) => index / 10_000);

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("createOpenAiCompatibleQueryEmbedder", () => {
  test("asks OpenRouter for a 1536-dimension vector from hosts that keep no data", async () => {
    const { impl, calls } = fakeFetch({ data: [{ index: 0, embedding: VECTOR }] });
    const embedder = createOpenAiCompatibleQueryEmbedder({
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1/",
      model: "google/gemini-embedding-001",
      fetch: impl,
    });

    const literal = await embedder.embed("ما هو التمثيل الضوئي؟");

    expect(embedder.model).toBe("google/gemini-embedding-001@1536");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: "google/gemini-embedding-001",
      input: ["ما هو التمثيل الضوئي؟"],
      dimensions: AI_EMBEDDING_DIMENSIONS,
      provider: { data_collection: "deny" },
    });
    expect(literal.startsWith("[0,0.0001,0.0002,")).toBe(true);
    expect(literal.split(",")).toHaveLength(AI_EMBEDDING_DIMENSIONS);
  });

  test("sends no OpenRouter routing field to another host", async () => {
    const { impl, calls } = fakeFetch({ data: [{ index: 0, embedding: VECTOR }] });
    await createOpenAiCompatibleQueryEmbedder({
      apiKey: "k",
      baseUrl: "https://api.example.com/v1",
      model: "m",
      fetch: impl,
    }).embed("q");
    expect(JSON.parse(calls[0]!.init.body as string).provider).toBeUndefined();
  });

  test("throws on an HTTP error", async () => {
    const { impl } = fakeFetch({ error: { message: "rate limited" } }, 429);
    const embedder = createOpenAiCompatibleQueryEmbedder({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "m",
      fetch: impl,
    });
    expect(embedder.embed("q")).rejects.toThrow("HTTP 429");
  });
});

describe("parseEmbeddingResponse", () => {
  test("returns the vectors in input order", () => {
    const other = VECTOR.map((value) => value + 1);
    const vectors = parseEmbeddingResponse(
      {
        data: [
          { index: 1, embedding: other },
          { index: 0, embedding: VECTOR },
        ],
      },
      2,
    );
    expect(vectors[0]).toEqual(VECTOR);
    expect(vectors[1]).toEqual(other);
  });

  test("rejects a missing vector, a wrong dimension or a non-finite value", () => {
    expect(() => parseEmbeddingResponse({ data: [] }, 1)).toThrow("0 vectors for 1 inputs");
    expect(() => parseEmbeddingResponse({ data: [{ index: 0, embedding: [1, 2] }] }, 1)).toThrow(
      "malformed",
    );
    const broken = [...VECTOR];
    broken[5] = Number.NaN;
    expect(() => parseEmbeddingResponse({ data: [{ index: 0, embedding: broken }] }, 1)).toThrow(
      "malformed",
    );
    expect(() => parseEmbeddingResponse(null, 1)).toThrow();
  });
});

describe("embedForSearch", () => {
  test("no embedder searches by keyword only", async () => {
    expect(await embedForSearch(null, "q", () => undefined)).toEqual({ queryVector: null });
  });

  test("carries the vector with the embedder's model, so the semantic leg reads that model only", async () => {
    const embedder: QueryEmbedder = { model: "m@1536", embed: async () => "[1,2]" };
    expect(await embedForSearch(embedder, "q", () => undefined)).toEqual({
      queryVector: "[1,2]",
      embeddingModel: "m@1536",
    });
  });

  test("a failed embedding falls back to keyword search and reports the error", async () => {
    const errors: unknown[] = [];
    const embedder: QueryEmbedder = {
      model: "m@1536",
      embed: async () => {
        throw new Error("provider down");
      },
    };
    expect(await embedForSearch(embedder, "q", (error) => errors.push(error))).toEqual({
      queryVector: null,
    });
    expect(errors).toHaveLength(1);
  });
});
