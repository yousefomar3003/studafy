import type { GroundedSource } from "./prompt";

/**
 * Citation extraction and validation for Ask AI (ST-165).
 *
 * The model is instructed to cite each factual claim with the bracketed id of the source it came
 * from, e.g. `[2]` (see `prompt.ts`). That text is untrusted model output, so the citations are
 * never taken at face value: {@link resolveCitations} maps each bracketed id back through the
 * *retrieved* source set and drops everything that does not resolve. An id of `[0]`, an id larger
 * than the source count, or a reference to a source that was never retrieved is a hallucination and
 * is discarded here, so the machine-readable citations the API returns — and the rows it persists
 * into `app.ai_message_citations` — always point at real chunks the retrieval actually produced.
 *
 * The database is the second validator, not a replacement for this one: `ai_message_citations`
 * carries a composite FK to `app.material_chunks (id, school_id)`, so a chunk deleted between
 * retrieval and persistence fails the insert and rolls the message back with it.
 */

export interface Citation {
  /** The source's 1-based position, as the model wrote it (`[order]`). */
  order: number;
  /** `app.material_chunks.id` the citation resolves to — always one that was retrieved. */
  chunkId: string;
  materialId: string;
  materialTitle: string | null;
  pageNumber: number | null;
  sectionTitle: string | null;
}

/**
 * Extract the bracketed numeric ids from answer text, in first-appearance order, deduplicated.
 *
 * This is the raw extractor: it accepts any positive integer and leaves the resolve/validate step
 * to {@link resolveCitations}, which bounds the ids against the actual source set. Negative and
 * zero ids are dropped here because no source order can ever be valid for them.
 */
export function parseCitationOrders(text: string): number[] {
  const orders: number[] = [];
  const seen = new Set<number>();
  const pattern = /\[(\d+)\]/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const order = Number(match[1]);
    if (order >= 1 && !seen.has(order)) {
      seen.add(order);
      orders.push(order);
    }
  }
  return orders;
}

/**
 * Resolve the citations in an answer against the sources the model was actually grounded on.
 *
 * Every returned citation's `chunkId` is the chunk id of a real retrieved source — that is the
 * validator the "citations resolve to real chunks" acceptance criterion names. An id that does not
 * map onto the source set (out of range, or fabricated) is omitted.
 */
export function resolveCitations(text: string, sources: readonly GroundedSource[]): Citation[] {
  const byOrder = new Map(sources.map((source) => [source.order, source]));
  const citations: Citation[] = [];

  for (const order of parseCitationOrders(text)) {
    const source = byOrder.get(order);
    if (!source) continue;
    citations.push({
      order: source.order,
      chunkId: source.chunkId,
      materialId: source.materialId,
      materialTitle: source.materialTitle,
      pageNumber: source.pageNumber,
      sectionTitle: source.sectionTitle,
    });
  }

  return citations;
}
