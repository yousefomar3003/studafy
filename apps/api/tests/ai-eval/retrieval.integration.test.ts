/**
 * RAG eval against real retrieval — the golden set through live PostgreSQL (NFR-11, QA-15/F-06).
 *
 * `harness.test.ts` scores hand-written hit lists, so it gates the decision layer but cannot say
 * anything about a retrieval *configuration*. This file closes that gap: every chunk in the golden
 * set is seeded into one tenant's corpus (one shared corpus, so every case has the other cases'
 * chunks as distractors), each case's query is run through the production `hybridSearch` under a
 * real tenant transaction, and the production `assessGrounding` decides answer-or-refuse from the
 * hits that actually came back.
 *
 * Two configurations are measured side by side:
 *
 *   - `lexical`     — the production configuration chosen in ADR-020: no query vector, keyword leg
 *                     only. Gated against the NFR-11 thresholds.
 *   - `mock-hybrid` — the pre-ADR-020 production configuration: chunks and query embedded with the
 *                     content-hash mock (the exact vectors the ingestion worker writes), fused by
 *                     RRF. Printed as the baseline, never gated — it is the defect F-06 describes.
 *
 * Metrics (scoring.ts), per configuration:
 *   - refusal correctness: the gate's verdict on the real hits vs the case's expectation;
 *   - retrieval recall@k: the case's relevant chunks among the top `AI_ASK_SOURCE_LIMIT` hits;
 *   - groundedness: for cases the gate answered, the golden answer's sentences against the hits
 *     actually retrieved (would the sources handed to the model support that answer?).
 * Citation accuracy is a property of the model's output and citation resolution, not of retrieval,
 * so it stays in `harness.test.ts`.
 *
 * Set TEST_DATABASE_URL to run (skipped otherwise, like every DB-backed suite):
 *   TEST_DATABASE_URL=postgres://... bun run test:ai-eval
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { withTenantTx } from "../../src/db/tenant-tx";
import { assessGrounding } from "../../src/modules/ai/ask/refusal";
import { AI_ASK_SOURCE_LIMIT } from "../../src/modules/ai/config";
import {
  deterministicQueryEmbedding,
  RETRIEVAL_EMBEDDING_MODEL,
} from "../../src/modules/ai/retrieval/embeddings";
import { hybridSearch } from "../../src/modules/ai/retrieval/search";
import {
  createFullTenant,
  createMaterial,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TenantFixture,
  type TestDatabase,
} from "../harness";

import { GOLDEN_SET } from "./golden-set";
import { scoreGroundedness, scoreRefusalCorrectness, scoreRetrievalRecall } from "./scoring";

import type { TransactionSql } from "postgres";

// The NFR-11 targets, the same values harness.test.ts gates on. Live lexical retrieval does NOT
// meet them yet (recorded in docs/security/NFR-11_rag_groundedness.md and ADR-020): the keyword leg's
// websearch_to_tsquery ANDs every word of a natural-language question. Until the keyword-leg
// follow-up lands, CI gates on the measured floor below so retrieval cannot regress silently; raise
// the floor with every improvement and delete it once the targets hold.
const NFR11_GROUNDEDNESS = 0.95;
const NFR11_REFUSAL_CORRECTNESS = 0.95;
/** Measured 2026-11-03, lexical, on this golden set (ADR-020). A ratchet — only ever raise it. */
const FLOOR_GROUNDEDNESS = 0.75;
const FLOOR_REFUSAL_CORRECTNESS = 0.6;
const FLOOR_RECALL = 0.318;

type Config = "lexical" | "mock-hybrid";

interface CaseResult {
  id: string;
  shouldRefuse: boolean;
  answered: boolean;
  refusalCorrectness: number;
  /** Null for refusal cases, which have no relevant chunks to recall. */
  recall: number | null;
  /** Null unless the gate answered a case that expects an answer. */
  groundedness: number | null;
  /** Rank of the first relevant chunk in the hits, 1-based; null when none was retrieved. */
  firstRelevantRank: number | null;
}

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let adminClient: ReturnType<typeof postgres> | undefined;
let tenantClient: ReturnType<typeof postgres> | undefined;
let tenant: TenantFixture;
let userId: string;
/** Golden chunk content → seeded `app.material_chunks.id`. */
const idByContent = new Map<string, string>();

async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await adminClient!.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

function relevantIds(c: (typeof GOLDEN_SET)[number]): string[] {
  return c.relevantChunkIds.map((chunkId) => {
    const content = c.hits.find((h) => h.chunkId === chunkId)!.content;
    return idByContent.get(content)!;
  });
}

async function evalCase(c: (typeof GOLDEN_SET)[number], config: Config): Promise<CaseResult> {
  const search = await withTenantTx(tenantClient!, { schoolId: tenant.schoolId, userId }, (tx) =>
    hybridSearch(tx, {
      query: c.query,
      queryVector: config === "lexical" ? null : deterministicQueryEmbedding(c.query),
      limit: AI_ASK_SOURCE_LIMIT,
    }),
  );
  const verdict = assessGrounding(search.hits, search.mode);
  const relevant = relevantIds(c);
  const hitIds = search.hits.map((h) => h.chunkId);
  const ranks = relevant.map((id) => hitIds.indexOf(id)).filter((i) => i >= 0);
  return {
    id: c.id,
    shouldRefuse: c.shouldRefuse,
    answered: verdict.grounded,
    refusalCorrectness: scoreRefusalCorrectness(verdict, c.shouldRefuse),
    recall: c.shouldRefuse ? null : scoreRetrievalRecall(search.hits, relevant),
    groundedness:
      !c.shouldRefuse && verdict.grounded ? scoreGroundedness(c.answer, search.hits) : null,
    firstRelevantRank: ranks.length > 0 ? Math.min(...ranks) + 1 : null,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

interface Summary {
  refusalCorrectness: number;
  recall: number;
  groundedness: number;
  answeredOfExpected: string;
}

function summarize(results: CaseResult[]): Summary {
  const expectAnswer = results.filter((r) => !r.shouldRefuse);
  const groundedScores = results.flatMap((r) => (r.groundedness === null ? [] : [r.groundedness]));
  return {
    refusalCorrectness: mean(results.map((r) => r.refusalCorrectness)),
    recall: mean(expectAnswer.map((r) => r.recall ?? 0)),
    groundedness: mean(groundedScores),
    answeredOfExpected: `${expectAnswer.filter((r) => r.answered).length}/${expectAnswer.length}`,
  };
}

function fmt(value: number | null): string {
  return value === null ? "  —  " : value.toFixed(2).padStart(5);
}

function table(config: Config, results: CaseResult[]): string {
  const s = summarize(results);
  const rows = results.map(
    (r) =>
      `${r.id.padEnd(28)} ${(r.shouldRefuse ? "refuse" : "answer").padEnd(7)} ${(r.answered ? "answer" : "refuse").padEnd(7)} ${fmt(r.refusalCorrectness)}  ${fmt(r.recall)}  ${fmt(r.groundedness)}  ${r.firstRelevantRank === null ? "  —" : String(r.firstRelevantRank).padStart(3)}`,
  );
  return [
    `RAG retrieval eval — ${config} (k=${AI_ASK_SOURCE_LIMIT}, live PostgreSQL)`,
    "─".repeat(80),
    `${"Case".padEnd(28)} ${"Expect".padEnd(7)} ${"Got".padEnd(7)} Refuse  Recall  Ground  Rank`,
    "─".repeat(80),
    ...rows,
    "─".repeat(80),
    `refusal correctness ${s.refusalCorrectness.toFixed(3)} | recall@${AI_ASK_SOURCE_LIMIT} ${s.recall.toFixed(3)} | groundedness (answered) ${s.groundedness.toFixed(3)} | answered ${s.answeredOfExpected}`,
  ].join("\n");
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  // Pinned single connections, split admin seeding from tenant transactions — the same bun +
  // postgres.js environment note as retrieval-routes.integration.test.ts.
  adminClient = postgres(db.url, { max: 1, prepare: false });
  tenantClient = postgres(db.url, { max: 1, prepare: false });

  tenant = await createFullTenant(db.sql);
  userId = tenant.students[0]!.userId;
  const material = await createMaterial(db.sql, tenant.schoolId, {
    classId: tenant.cls.id,
    uploadedByUserId: tenant.teachers[0]!.userId,
    title: "Golden Corpus",
  });

  const contents = [...new Set(GOLDEN_SET.flatMap((c) => c.hits.map((h) => h.content)))];
  await asAdmin(tenant.schoolId, async (tx) => {
    for (const [index, content] of contents.entries()) {
      // The content-hash mock vector is exactly what the ingestion worker writes in production.
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.material_chunks
          (school_id, material_id, chunk_index, content, embedding, embedding_model)
        VALUES (${tenant.schoolId}, ${material.id}, ${index}, ${content},
                ${deterministicQueryEmbedding(content)}::public.vector, ${RETRIEVAL_EMBEDDING_MODEL})
        RETURNING id`;
      idByContent.set(content, row!.id);
    }
  });
});

afterAll(async () => {
  if (tenantClient) await tenantClient.end({ timeout: 1 });
  if (adminClient) await adminClient.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

describeDb("RAG eval — golden set through live retrieval", () => {
  const results = new Map<Config, CaseResult[]>();

  async function run(config: Config): Promise<CaseResult[]> {
    const cached = results.get(config);
    if (cached) return cached;
    const out: CaseResult[] = [];
    // Sequential: one pinned tenant connection.
    for (const c of GOLDEN_SET) out.push(await evalCase(c, config));
    results.set(config, out);
    return out;
  }

  test("mock-hybrid baseline (pre-ADR-020 production) is measured, not gated", async () => {
    const out = await run("mock-hybrid");
    console.log(`\n${table("mock-hybrid", out)}\n`);
    expect(out).toHaveLength(GOLDEN_SET.length);
  });

  test("lexical (production, ADR-020) is printed for the NFR-11 record", async () => {
    const out = await run("lexical");
    console.log(`\n${table("lexical", out)}\n`);
    expect(out).toHaveLength(GOLDEN_SET.length);
  });

  test(`lexical: no regression below the measured floor (NFR-11 targets: refusal ≥ ${NFR11_REFUSAL_CORRECTNESS}, groundedness ≥ ${NFR11_GROUNDEDNESS} — not yet met)`, async () => {
    const s = summarize(await run("lexical"));
    expect(s.refusalCorrectness).toBeGreaterThanOrEqual(FLOOR_REFUSAL_CORRECTNESS);
    expect(s.groundedness).toBeGreaterThanOrEqual(FLOOR_GROUNDEDNESS);
    expect(s.recall).toBeGreaterThanOrEqual(FLOOR_RECALL - 1e-9);
  });
});
