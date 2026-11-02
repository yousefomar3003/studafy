// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { estimateTokens } from "./chunker";
import {
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_MAX_RETRIES,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EmbeddingRateLimitError,
  createEmbeddingStage,
  createMockEmbeddingProvider,
  mockEmbedding,
} from "./embedding";

import type { EmbeddingProvider } from "./embedding";
import type { MaterialChunk } from "./types";

const chunkOf = (chunkIndex: number, content: string): MaterialChunk => ({
  chunkIndex,
  content,
  pageNumber: null,
  sectionTitle: null,
});

/** A controllable provider: records every call and serves the given responses in order. */
class ScriptedProvider implements EmbeddingProvider {
  readonly model = EMBEDDING_MODEL;
  calls: string[][] = [];
  constructor(
    private readonly responses: (texts: readonly string[]) => Promise<readonly string[]>,
  ) {}

  async embed(texts: readonly string[]): Promise<readonly string[]> {
    this.calls.push([...texts]);
    return this.responses(texts);
  }
}

/** A provider that fails with a rate limit a fixed number of times, then serves vectors. */
function flakyProvider(failures: number, vectors: (texts: readonly string[]) => string[]) {
  let remaining = failures;
  return new ScriptedProvider(async (texts) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new EmbeddingRateLimitError();
    }
    return vectors(texts);
  });
}

const SENTENCE = "Photosynthesis converts light energy into chemical energy stored in glucose. ";

describe("createMockEmbeddingProvider", () => {
  test("is deterministic, 1536-dimension pgvector literals under EMBEDDING_MODEL", async () => {
    const provider = createMockEmbeddingProvider();
    expect(provider.model).toBe(EMBEDDING_MODEL);

    const [first, second] = await provider.embed(["photosynthesis light", "photosynthesis dark"]);
    expect(first).toBe(mockEmbedding("photosynthesis light"));
    expect(second).toBe(mockEmbedding("photosynthesis dark"));
    expect(first).not.toBe(second);

    const parts = first.slice(1, -1).split(",");
    expect(parts).toHaveLength(EMBEDDING_DIMENSIONS);
    for (const part of parts) expect(Number.isFinite(Number(part))).toBe(true);
  });
});

describe("EmbeddingStage", () => {
  test("embeds every chunk in order with the provider's model id", async () => {
    const provider = new ScriptedProvider(async (texts) => texts.map((_, i) => `[${i}]`));
    const stage = createEmbeddingStage(provider);

    const chunks = [chunkOf(0, "first"), chunkOf(1, "second"), chunkOf(2, "third")];
    const { chunks: embedded, tokens } = await stage.embed(chunks);

    expect(embedded.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);
    expect(embedded.map((chunk) => chunk.embedding)).toEqual(["[0]", "[1]", "[2]"]);
    expect(embedded.every((chunk) => chunk.embeddingModel === EMBEDDING_MODEL)).toBe(true);
    expect(tokens).toBe(chunks.reduce((sum, chunk) => sum + estimateTokens(chunk.content), 0));
  });

  test("folds chunks into batches bounded by both chunk count and token budget", async () => {
    const provider = new ScriptedProvider(async (texts) => texts.map((_, i) => `[${i}]`));
    // Chunks of 5 chars are 2 tokens each under the 4-char rule.
    const chunks = [chunkOf(0, "aaaaa"), chunkOf(1, "bbbbb"), chunkOf(2, "ccccc")];

    // Chunk-count bound: 2 chunks per call.
    const byCount = createEmbeddingStage(provider, { maxBatchChunks: 2, maxBatchTokens: 1000 });
    await byCount.embed(chunks);
    expect(provider.calls.map((call) => call.length)).toEqual([2, 1]);

    // Token bound: 5 tokens per call -> 2 + 2 fits, 2 + 2 + 2 does not.
    const provider2 = new ScriptedProvider(async (texts) => texts.map((_, i) => `[${i}]`));
    const byTokens = createEmbeddingStage(provider2, { maxBatchChunks: 10, maxBatchTokens: 5 });
    await byTokens.embed(chunks);
    expect(provider2.calls.map((call) => call.length)).toEqual([2, 1]);
  });

  test("a single chunk over the token budget is still sent, not dropped", async () => {
    const provider = new ScriptedProvider(async (texts) => texts.map(() => "[0]"));
    const stage = createEmbeddingStage(provider, { maxBatchTokens: 2 });

    const chunks = [chunkOf(0, SENTENCE.repeat(20))]; // ~200 tokens > 2
    const { chunks: embedded } = await stage.embed(chunks);

    expect(provider.calls).toHaveLength(1);
    expect(embedded).toHaveLength(1);
  });

  test("retries rate-limited batches with exponential backoff until they succeed", async () => {
    const sleeps: number[] = [];
    const provider = flakyProvider(2, (texts) => texts.map(() => "[ok]"));
    const stage = createEmbeddingStage(provider, {
      backoffMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const { chunks } = await stage.embed([chunkOf(0, "hello")]);

    expect(provider.calls).toHaveLength(3); // 1 attempt + 2 retries
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.embedding).toBe("[ok]");
    // Full jitter yields some value in [0, delay), so only the bounds are asserted.
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]!).toBeLessThan(100);
    expect(sleeps[1]!).toBeLessThan(200);
  });

  test("gives up after maxRetries rate-limited attempts", async () => {
    const provider = new ScriptedProvider(async () => {
      throw new EmbeddingRateLimitError();
    });
    const stage = createEmbeddingStage(provider, {
      backoffMs: 100,
      maxBackoffMs: 200,
      sleep: async () => undefined,
    });

    await expect(stage.embed([chunkOf(0, "hello")])).rejects.toBeInstanceOf(
      EmbeddingRateLimitError,
    );
    expect(provider.calls).toHaveLength(DEFAULT_MAX_RETRIES + 1);
  });

  test("backoff never exceeds the cap", async () => {
    const sleeps: number[] = [];
    const provider = new ScriptedProvider(async () => {
      throw new EmbeddingRateLimitError();
    });
    const stage = createEmbeddingStage(provider, {
      backoffMs: 1000,
      maxBackoffMs: 1500,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(stage.embed([chunkOf(0, "hello")])).rejects.toBeInstanceOf(
      EmbeddingRateLimitError,
    );
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(DEFAULT_MAX_BACKOFF_MS);
  });

  test("non-rate-limit errors propagate without retry", async () => {
    const provider = new ScriptedProvider(async () => {
      throw new Error("model blew up");
    });
    const stage = createEmbeddingStage(provider, { sleep: async () => undefined });

    await expect(stage.embed([chunkOf(0, "hello")])).rejects.toThrow("model blew up");
    expect(provider.calls).toHaveLength(1);
  });

  test("a provider returning the wrong vector count fails the job loudly", async () => {
    const provider = new ScriptedProvider(async (texts) => texts.map(() => "[0]").slice(0, -1));
    const stage = createEmbeddingStage(provider);

    await expect(stage.embed([chunkOf(0, "hello"), chunkOf(1, "world")])).rejects.toThrow(
      /returned 1 vectors for a 2-chunk batch/,
    );
  });

  test("paces batches through the rate limiter when configured", async () => {
    const provider = new ScriptedProvider(async (texts) => texts.map(() => "[0]"));
    const stage = createEmbeddingStage(provider, { requestsPerSecond: 1_000, maxBatchChunks: 1 });

    await stage.embed([chunkOf(0, "a"), chunkOf(1, "b"), chunkOf(2, "c")]);

    expect(provider.calls).toHaveLength(3);
  });

  test("meters the token count of every completed batch to the tenant", async () => {
    const provider = new ScriptedProvider(async (texts) => texts.map(() => "[0]"));
    const stage = createEmbeddingStage(provider, { maxBatchChunks: 1 });

    const records: { schoolId: string; tokens: number }[] = [];
    const chunks = [chunkOf(0, "alpha"), chunkOf(1, "beta")];
    const { tokens } = await stage.embed(chunks, {
      schoolId: "school-1",
      meter: {
        record: (schoolId, recordTokens) => {
          records.push({ schoolId, tokens: recordTokens });
        },
      },
    });

    expect(records).toEqual([
      { schoolId: "school-1", tokens: estimateTokens("alpha") },
      { schoolId: "school-1", tokens: estimateTokens("beta") },
    ]);
    expect(tokens).toBe(records.reduce((sum, record) => sum + record.tokens, 0));
  });

  test("metering is a no-op when no meter is supplied", async () => {
    const provider = new ScriptedProvider(async (texts) => texts.map(() => "[0]"));
    const stage = createEmbeddingStage(provider);

    await expect(stage.embed([chunkOf(0, "hello")])).resolves.toMatchObject({ tokens: 2 });
  });
});
