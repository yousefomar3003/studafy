import { expect, test } from "@playwright/test";

import { apiLoginAs, bearer } from "./support/auth";
import { PERSONAS } from "./support/personas";
import { API_BASE_URL } from "./support/ports";
import { resolveStudentId } from "./support/students";

interface SseEvent {
  event: string;
  data: unknown;
}

/** Parses a `text/event-stream` body into typed `event:`/`data:` pairs, in arrival order. */
async function readSse(response: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventLine = block.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      events.push({
        event: eventLine.slice("event:".length).trim(),
        data: JSON.parse(dataLine.slice("data:".length).trim()),
      });
    }
  }
  return events;
}

/**
 * Journey 6/7: AI ask with citations.
 *
 * The web app has no Ask AI screen at all today — it exists only in the Flutter mobile app's
 * hand-written SSE client (see the ST-246 journey catalog). This spec is API/SSE-only rather than
 * inventing a browser flow to test: it drives `POST /api/ai/students/{studentId}/ask` directly and
 * asserts on the real event stream, exactly the contract the eventual web (or any) client consumes.
 *
 * The LLM generation leg is faked (`ANTHROPIC_BASE_URL` → tests/mocks/fake-anthropic.ts — see
 * playwright.critical.config.ts) but retrieval is completely real: real hybrid search (vector + full
 * text) over the real seeded "Photosynthesis Study Guide" chunks (db/seeds/data/materials.ts), real
 * grounded-prompt assembly, and real citation resolution matching the model's `[1]` back-reference
 * against the chunks retrieval actually returned (ai/ask/citations.ts) — a hallucinated bracket ref
 * would be silently dropped, so a citation surviving this pipeline is a genuine one. The question
 * below deliberately echoes that corpus's real vocabulary — see fake-anthropic.ts's own comment for
 * why that matters against this repo's deterministic mock embeddings.
 */
test.describe("AI ask with citations", () => {
  test("a student asks a grounded question and gets a cited, streamed answer", async ({
    request,
  }) => {
    const adminToken = await apiLoginAs(request, PERSONAS.orgAdmin);
    const studentId = await resolveStudentId(request, adminToken, PERSONAS.aiStudent);
    const studentToken = await apiLoginAs(request, PERSONAS.aiStudent);

    const response = await fetch(`${API_BASE_URL}/api/ai/students/${studentId}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(studentToken) },
      body: JSON.stringify({
        question: "What is photosynthesis and how does it convert light energy into glucose?",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(response);
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("sources");
    expect(eventTypes).toContain("done");
    expect(eventTypes).not.toContain("refusal");
    expect(eventTypes).not.toContain("error");

    const sources = events.find((e) => e.event === "sources")!.data as {
      sources: { order: number; material_title: string }[];
    };
    expect(sources.sources.length).toBeGreaterThan(0);
    expect(sources.sources[0].material_title).toBe("Photosynthesis Study Guide");

    const done = events.find((e) => e.event === "done")!.data as {
      text: string;
      citations: { order: number; material_title: string; chunk_id: string }[];
      usage: { total_tokens: number };
    };
    expect(done.text).toContain("Photosynthesis converts light energy");
    expect(done.citations.length).toBeGreaterThan(0);
    expect(done.citations[0].material_title).toBe("Photosynthesis Study Guide");
    expect(done.usage.total_tokens).toBeGreaterThan(0);

    // More than one delta event is the proof the answer actually streamed rather than arriving in
    // one frame — the fake Anthropic server yields one per word specifically so this holds.
    const deltaEvents = events.filter((e) => e.event === "delta");
    expect(deltaEvents.length).toBeGreaterThan(1);
  });
});
