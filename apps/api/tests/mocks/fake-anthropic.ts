import { randomUUID } from "node:crypto";

import { Hono } from "hono";

/**
 * A local stand-in for the Anthropic Messages API (`POST /v1/messages`), for E2E only.
 *
 * `AnthropicProvider` (apps/api/src/modules/ai/llm/provider.ts) takes its base URL from
 * `ANTHROPIC_BASE_URL` with no other code change needed, so pointing the real provider at this
 * server — `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/v1`, any non-empty `ANTHROPIC_API_KEY` — is
 * enough to run the whole AI-ask pipeline (retrieval → grounded prompt → citations → SSE) against a
 * live server without a real Anthropic key or a network call. Every other request field
 * (`x-api-key`, `anthropic-version`, `model`, `messages`) is accepted and ignored: the answer is
 * always the same deterministic, citation-bearing sentence.
 *
 * Deliberately not a general-purpose fake — the ask route's grounded prompt structure and citation
 * anchor format are documented in ai/ask/prompt.ts and ai/ask/citations.ts, and this server's answer
 * is written to satisfy exactly that contract (a `[1]` back-reference to the first retrieved
 * source), not to simulate Anthropic's actual behavior.
 */

// Deliberately echoes real seeded chunk vocabulary (db/seeds/data/materials.ts's "Photosynthesis
// Study Guide" corpus, chunk index 0: "Photosynthesis converts light energy into chemical energy
// stored in glucose.") — the AI-ask journey's question does the same, so this suite's fixed
// deterministic mock-embedding hybrid search (vector leg is phase-random per query text; the FTS
// leg is genuinely content-aware, see ai/retrieval/embeddings.ts) reliably ranks that chunk first
// and `[1]` resolves to a real citation rather than a hallucinated one (ai/ask/citations.ts).
export const FAKE_ANTHROPIC_ANSWER =
  "Photosynthesis converts light energy into chemical energy stored in glucose, which plants use " +
  "to grow [1].";

function usage(promptChars: number, answerChars: number): { input: number; output: number } {
  // A deterministic, roughly-token-shaped count is enough — nothing downstream asserts on the exact
  // value, only that usage is present and the AI quota meter has something non-zero to commit.
  return {
    input: Math.max(1, Math.ceil(promptChars / 4)),
    output: Math.max(1, Math.ceil(answerChars / 4)),
  };
}

interface MessagesRequestBody {
  model?: string;
  stream?: boolean;
  messages?: { role: string; content: string }[];
}

/** Build the fake Anthropic app. Mount directly or serve standalone via `Bun.serve`. */
export function createFakeAnthropic(): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    const body = (await c.req.json()) as MessagesRequestBody;
    const model = body.model ?? "unknown";
    const promptChars = (body.messages ?? []).reduce((sum, m) => sum + m.content.length, 0);
    const { input, output } = usage(promptChars, FAKE_ANTHROPIC_ANSWER.length);

    if (!body.stream) {
      return c.json({
        id: `msg_fake_${randomUUID()}`,
        type: "message",
        model,
        role: "assistant",
        content: [{ type: "text", text: FAKE_ANTHROPIC_ANSWER }],
        stop_reason: "end_turn",
        usage: { input_tokens: input, output_tokens: output },
      });
    }

    // SSE, shaped exactly as AnthropicProvider.readSse parses it: message_start (carries input
    // usage) → one content_block_delta per word (so a real streaming UI sees more than one chunk) →
    // message_delta (carries cumulative output usage + stop_reason) → message_stop.
    const words = FAKE_ANTHROPIC_ANSWER.split(" ");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        send("message_start", {
          type: "message_start",
          message: { model, usage: { input_tokens: input, output_tokens: 0 } },
        });
        words.forEach((word, index) => {
          const text = index === 0 ? word : ` ${word}`;
          send("content_block_delta", {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          });
        });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: output },
        });
        send("message_stop", { type: "message_stop" });
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  });

  return app;
}
