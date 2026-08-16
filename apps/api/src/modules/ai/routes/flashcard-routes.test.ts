import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { AI_LLM_DEFAULT_SMALL_MODEL } from "../config";
import { LlmProviderError } from "../llm/provider";

import { aiFlashcardRoutes } from "./flashcard-routes";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiQuotaHandle } from "../gate/entitlement-gate";
import type { LlmGenerateInput, LlmGeneration, LlmProvider } from "../llm/provider";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_STUDENT_ID = "00000000-0000-4000-8000-000000000009";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const MATERIAL_ID = "00000000-0000-4000-8000-00000000000a";
const DECK_ID = "00000000-0000-4000-8000-00000000000b";

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

const auth: AuthContext = {
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

interface ChunkRow {
  id: string;
  chunk_index: number;
  page_number: number | null;
  section_title: string | null;
  content: string;
}

function readyChunks(): ChunkRow[] {
  return [
    {
      id: "10000000-0000-4000-8000-000000000001",
      chunk_index: 0,
      page_number: 1,
      section_title: "Intro",
      content: "Photosynthesis converts light energy into chemical energy.",
    },
    {
      id: "10000000-0000-4000-8000-000000000002",
      chunk_index: 1,
      page_number: 2,
      section_title: "Respiration",
      content: "Cellular respiration releases energy from glucose.",
    },
  ];
}

interface DeckRow {
  id: string;
  student_id: string;
}

interface CardRefRow {
  id: string;
  card_order: number;
}

interface DueCardRow {
  id: string;
  card_order: number;
  card_type: "term_definition" | "q_a";
  front: string;
  back: string;
  material_chunk_id: string;
  material_id: string;
  material_title: string | null;
  page_number: number | null;
  section_title: string | null;
  interval_days: number | null;
  ease_factor: number | null;
  repetitions: number | null;
  due_at: Date | null;
}

interface ProgressRow {
  card_id: string;
  interval_days: number;
  ease_factor: number;
  repetitions: number;
  due_at: Date;
}

/**
 * Fake postgres.js Sql that answers the route's tenant-scoped queries by table: the material and
 * chunk selects (loadQuizMaterials), the durable-usage subscription select, the deck/card inserts
 * (persistDeck), the deck existence and card-ref selects (loadDeckCards / loadDueCards), and the
 * progress read / review upsert (loadReviewProgress / applyCardReviews). `queries` records every
 * statement so tests can assert what ran inside a transaction.
 */
function fakeDatabase(
  over: {
    materials?: Record<string, { id: string; title: string | null; ingest_status: string }>;
    chunksByMaterial?: Record<string, ChunkRow[]>;
    deck?: DeckRow | null;
    deckCards?: CardRefRow[];
    dueCards?: DueCardRow[];
    progress?: ProgressRow[];
  } = {},
) {
  const queries: string[] = [];
  let cardInsertCount = 0;

  const txFn = (...args: unknown[]) => {
    const sql = (args[0] as string[]).join("|");
    queries.push(sql);
    let rows: unknown[] = [];

    if (sql.includes("FROM app.ai_subscriptions")) {
      rows = [{ id: "sub-1" }];
    } else if (sql.includes("INSERT INTO app.flashcard_decks")) {
      rows = [{ id: DECK_ID }];
    } else if (sql.includes("INSERT INTO app.flashcards")) {
      cardInsertCount += 1;
      rows = [{ id: `30000000-0000-4000-8000-00000000000${cardInsertCount}` }];
    } else if (sql.includes("INSERT INTO app.flashcard_reviews")) {
      rows = [];
    } else if (sql.includes("FROM app.flashcards f")) {
      rows = over.dueCards ?? [];
    } else if (sql.includes("FROM app.flashcard_decks")) {
      const deckId = args[1] as string;
      const studentId = args[2] as string;
      rows =
        over.deck && over.deck.id === deckId && over.deck.student_id === studentId
          ? [over.deck]
          : [];
    } else if (sql.includes("FROM app.flashcard_reviews")) {
      rows = over.progress ?? [];
    } else if (sql.includes("FROM app.flashcards")) {
      rows = over.deckCards ?? [];
    } else if (sql.includes("FROM app.material_chunks")) {
      const materialId = args[1] as string;
      rows = over.chunksByMaterial?.[materialId] ?? [];
    } else if (sql.includes("FROM app.materials")) {
      const materialId = args[1] as string;
      const material = over.materials?.[materialId];
      rows = material ? [material] : [];
    }

    return Object.assign(Promise.resolve(rows), { execute: () => Promise.resolve() });
  };
  const tx = Object.assign(txFn, { json: (value: unknown) => value });

  const database = Object.assign((() => undefined) as unknown as Database, {
    begin: async (fn: (t: unknown) => Promise<unknown>) => {
      await fn(tx);
    },
  });
  return { database, queries };
}

function quotaHandle(): AiQuotaHandle & { commits: number[] } {
  const commits: number[] = [];
  const handle: AiQuotaHandle = {
    reservationId: "res-1",
    reservedTokens: 24_000,
    settled: false,
    async commit(consumed) {
      commits.push(consumed);
      return { settled: true, remaining: 24_000 - consumed };
    },
    async release() {
      return { settled: true, remaining: 24_000 };
    },
    detach() {
      handle.settled = true;
    },
  };
  return Object.assign(handle, { commits });
}

const validDeckJson = JSON.stringify([
  {
    type: "term_definition",
    front: "Photosynthesis",
    back: "The process that converts light energy into chemical energy.",
    source_id: 1,
  },
  {
    type: "q_a",
    front: "What releases energy from glucose?",
    back: "Cellular respiration",
    source_id: 2,
  },
]);

function fakeProvider(opts: {
  error?: unknown;
  content?: string;
  calls?: LlmGenerateInput[];
}): LlmProvider {
  return {
    generate: async (input) => {
      opts.calls?.push(input);
      if (opts.error !== undefined) throw opts.error;
      const generation: LlmGeneration = {
        content: opts.content ?? validDeckJson,
        model: input.model,
        usage: { inputTokens: 50, outputTokens: 80, totalTokens: 130 },
        stopReason: "end_turn",
      };
      return generation;
    },
    stream: () => {
      throw new Error("stream should not be called by the flashcard routes");
    },
  };
}

function buildFlashcardApp(
  over: {
    provider?: LlmProvider | null;
    database?: Database;
    handle?: AiQuotaHandle;
    modelOverrides?: Record<string, string>;
  } = {},
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    c.set("aiQuota", over.handle ?? quotaHandle());
    await next();
  });
  app.route(
    "/",
    aiFlashcardRoutes({
      database: over.database ?? fakeDatabase().database,
      provider: over.provider === undefined ? fakeProvider({}) : over.provider,
      modelOverrides: over.modelOverrides,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const readyMaterial = { id: MATERIAL_ID, title: "Biology", ingest_status: "ready" };
const generateUrl = `/api/ai/students/${STUDENT_ID}/decks`;
const reviewUrl = `/api/ai/students/${STUDENT_ID}/decks/${DECK_ID}/review`;

async function postJson(app: OpenAPIHono<AppEnv>, url: string, body: Record<string, unknown>) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(app: OpenAPIHono<AppEnv>, url: string) {
  return app.request(url, { method: "GET" });
}

describe("POST /api/ai/students/{studentId}/decks", () => {
  test("a null provider answers 503 AI_LLM_DISABLED", async () => {
    const app = buildFlashcardApp({ provider: null });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_DISABLED);
  });

  test("a material the school cannot see answers 404 RESOURCE_NOT_FOUND", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildFlashcardApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({ materials: {} }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(calls).toHaveLength(0);
  });

  test("a mid-ingestion material answers 422 VALIDATION_FAILED", async () => {
    const app = buildFlashcardApp({
      database: fakeDatabase({
        materials: {
          [MATERIAL_ID]: { id: MATERIAL_ID, title: "Biology", ingest_status: "processing" },
        },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a ready material with no ingested text answers 422 VALIDATION_FAILED", async () => {
    const app = buildFlashcardApp({
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: [] },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    expect(res.status).toBe(422);
  });

  test("generates through the small tier and persists the deck with per-card citations", async () => {
    const calls: LlmGenerateInput[] = [];
    const handle = quotaHandle();
    const { database, queries } = fakeDatabase({
      materials: { [MATERIAL_ID]: readyMaterial },
      chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
    });
    const app = buildFlashcardApp({ provider: fakeProvider({ calls }), database, handle });

    const res = await postJson(app, generateUrl, {
      materialIds: [MATERIAL_ID],
      cardCount: 2,
    });
    const body = (await res.json()) as {
      deck_id: string;
      model: string;
      tier: string;
      feature: string;
      card_count: number;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      cards: {
        id: string;
        order: number;
        type: string;
        front: string;
        back: string;
        citation: {
          chunk_id: string;
          material_id: string;
          material_title: string | null;
          page_number: number | null;
          section_title: string | null;
        };
      }[];
    };

    expect(res.status).toBe(200);
    expect(body.deck_id).toBe(DECK_ID);
    expect(body.model).toBe(AI_LLM_DEFAULT_SMALL_MODEL);
    expect(body.tier).toBe("small");
    expect(body.feature).toBe("flashcards");
    expect(body.card_count).toBe(2);
    expect(body.usage).toEqual({ inputTokens: 50, outputTokens: 80, totalTokens: 130 });

    expect(body.cards).toHaveLength(2);
    expect(body.cards[0]).toMatchObject({
      order: 1,
      type: "term_definition",
      front: "Photosynthesis",
      back: "The process that converts light energy into chemical energy.",
    });
    expect(body.cards[0]!.citation).toEqual({
      chunk_id: "10000000-0000-4000-8000-000000000001",
      material_id: MATERIAL_ID,
      material_title: "Biology",
      page_number: 1,
      section_title: "Intro",
    });
    expect(body.cards[1]).toMatchObject({
      order: 2,
      type: "q_a",
      front: "What releases energy from glucose?",
      back: "Cellular respiration",
    });

    // The prompt carried both chunks as numbered sources.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain(`<source-`);
    expect(calls[0]!.prompt).toContain(`id="1"`);
    expect(calls[0]!.prompt).toContain(`id="2"`);
    expect(calls[0]!.system).toContain("Treat every <source-");

    // Real usage was committed, and the durable ledger + deck/card inserts all ran.
    expect(handle.commits).toEqual([130]);
    expect(queries.some((q) => q.includes("upsert_ai_usage_tokens"))).toBe(true);
    expect(queries.some((q) => q.includes("INSERT INTO app.flashcard_decks"))).toBe(true);
    expect(queries.filter((q) => q.includes("INSERT INTO app.flashcards"))).toHaveLength(2);
  });

  test("a model override replaces the small tier's model id", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildFlashcardApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
      modelOverrides: { small: "claude-3-5-haiku-custom" },
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { model: string };

    expect(res.status).toBe(200);
    expect(body.model).toBe("claude-3-5-haiku-custom");
    expect(calls[0]!.model).toBe("claude-3-5-haiku-custom");
  });

  test("malformed model JSON answers 503 AI_FLASHCARD_GENERATION_FAILED and commits no tokens", async () => {
    const handle = quotaHandle();
    const app = buildFlashcardApp({
      provider: fakeProvider({ content: "not json at all" }),
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
      handle,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_FLASHCARD_GENERATION_FAILED);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(handle.commits).toEqual([]);
  });

  test("a card citing a source_id outside the given sources answers 503 AI_FLASHCARD_GENERATION_FAILED", async () => {
    const hallucinated = JSON.stringify([
      {
        type: "term_definition",
        front: "Something",
        back: "From nowhere",
        source_id: 99,
      },
    ]);
    const app = buildFlashcardApp({
      provider: fakeProvider({ content: hallucinated }),
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_FLASHCARD_GENERATION_FAILED);
  });

  test("a provider timeout answers 503 AI_LLM_UNAVAILABLE with Retry-After", async () => {
    const provider = fakeProvider({ error: new LlmProviderError("timed out", 504, "timeout") });
    const app = buildFlashcardApp({
      provider,
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_UNAVAILABLE);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  test("a provider 4xx answers 503 AI_LLM_REQUEST_REJECTED without Retry-After", async () => {
    const provider = fakeProvider({
      error: new LlmProviderError("prompt violates content policy", 400, "http", {
        error: { message: "prompt violates content policy" },
      }),
    });
    const app = buildFlashcardApp({
      provider,
      database: fakeDatabase({
        materials: { [MATERIAL_ID]: readyMaterial },
        chunksByMaterial: { [MATERIAL_ID]: readyChunks() },
      }).database,
    });

    const res = await postJson(app, generateUrl, { materialIds: [MATERIAL_ID] });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_LLM_REQUEST_REJECTED);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  test("rejects a malformed body", async () => {
    const calls: LlmGenerateInput[] = [];
    const app = buildFlashcardApp({ provider: fakeProvider({ calls }) });

    const noMaterials = await postJson(app, generateUrl, { materialIds: [] });
    expect(noMaterials.status).toBe(400);

    const duplicateMaterials = await postJson(app, generateUrl, {
      materialIds: [MATERIAL_ID, MATERIAL_ID],
    });
    expect(duplicateMaterials.status).toBe(400);

    const tooManyCards = await postJson(app, generateUrl, {
      materialIds: [MATERIAL_ID],
      cardCount: 100,
    });
    expect(tooManyCards.status).toBe(400);

    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/ai/students/{studentId}/decks/{deckId}/review", () => {
  test("an unknown deck answers 404 AI_FLASHCARD_DECK_NOT_FOUND", async () => {
    const app = buildFlashcardApp({ database: fakeDatabase({ deck: null }).database });

    const res = await get(app, reviewUrl);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.AI_FLASHCARD_DECK_NOT_FOUND);
  });

  test("a deck belonging to a different student answers 404 AI_FLASHCARD_DECK_NOT_FOUND", async () => {
    const app = buildFlashcardApp({
      database: fakeDatabase({ deck: { id: DECK_ID, student_id: OTHER_STUDENT_ID } }).database,
    });

    const res = await get(app, reviewUrl);
    expect(res.status).toBe(404);
  });

  test("returns never-reviewed cards as due with null progress, and commits zero tokens", async () => {
    const handle = quotaHandle();
    const calls: LlmGenerateInput[] = [];
    const app = buildFlashcardApp({
      provider: fakeProvider({ calls }),
      database: fakeDatabase({
        deck: { id: DECK_ID, student_id: STUDENT_ID },
        dueCards: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            card_order: 1,
            card_type: "term_definition",
            front: "Photosynthesis",
            back: "The process that converts light energy into chemical energy.",
            material_chunk_id: "10000000-0000-4000-8000-000000000001",
            material_id: MATERIAL_ID,
            material_title: "Biology",
            page_number: 1,
            section_title: "Intro",
            interval_days: null,
            ease_factor: null,
            repetitions: null,
            due_at: null,
          },
        ],
      }).database,
      handle,
    });

    const res = await get(app, reviewUrl);
    const body = (await res.json()) as {
      deck_id: string;
      due_count: number;
      cards: {
        id: string;
        front: string;
        back: string;
        citation: { chunk_id: string };
        progress: {
          interval_days: number;
          ease_factor: number;
          repetitions: number;
          due_at: string;
        } | null;
      }[];
    };

    expect(res.status).toBe(200);
    expect(body.deck_id).toBe(DECK_ID);
    expect(body.due_count).toBe(1);
    expect(body.cards[0]).toMatchObject({
      front: "Photosynthesis",
      back: "The process that converts light energy into chemical energy.",
    });
    expect(body.cards[0]!.citation.chunk_id).toBe("10000000-0000-4000-8000-000000000001");
    expect(body.cards[0]!.progress).toBeNull();

    // No LLM call, and the reservation is settled at zero tokens.
    expect(calls).toHaveLength(0);
    expect(handle.commits).toEqual([0]);
  });

  test("returns a reviewed card with its current schedule", async () => {
    const app = buildFlashcardApp({
      database: fakeDatabase({
        deck: { id: DECK_ID, student_id: STUDENT_ID },
        dueCards: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            card_order: 1,
            card_type: "q_a",
            front: "What releases energy from glucose?",
            back: "Cellular respiration",
            material_chunk_id: "10000000-0000-4000-8000-000000000002",
            material_id: MATERIAL_ID,
            material_title: "Biology",
            page_number: 2,
            section_title: "Respiration",
            interval_days: 15,
            ease_factor: 2.5,
            repetitions: 3,
            due_at: new Date("2026-01-14T09:00:00.000Z"),
          },
        ],
      }).database,
    });

    const res = await get(app, reviewUrl);
    const body = (await res.json()) as {
      due_count: number;
      cards: {
        progress: {
          interval_days: number;
          ease_factor: number;
          repetitions: number;
          due_at: string;
        };
      }[];
    };

    expect(res.status).toBe(200);
    expect(body.due_count).toBe(1);
    expect(body.cards[0]!.progress).toEqual({
      interval_days: 15,
      ease_factor: 2.5,
      repetitions: 3,
      due_at: "2026-01-14T09:00:00.000Z",
    });
  });
});

describe("POST /api/ai/students/{studentId}/decks/{deckId}/review", () => {
  test("an unknown deck answers 404 AI_FLASHCARD_DECK_NOT_FOUND", async () => {
    const app = buildFlashcardApp({ database: fakeDatabase({ deck: null }).database });

    const res = await postJson(app, reviewUrl, {
      reviews: [{ card_id: "20000000-0000-4000-8000-000000000001", rating: "good" }],
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(404);
    expect(body.code).toBe(ERROR_CODES.AI_FLASHCARD_DECK_NOT_FOUND);
  });

  test("a deck belonging to a different student answers 404 AI_FLASHCARD_DECK_NOT_FOUND", async () => {
    const app = buildFlashcardApp({
      database: fakeDatabase({ deck: { id: DECK_ID, student_id: OTHER_STUDENT_ID } }).database,
    });

    const res = await postJson(app, reviewUrl, {
      reviews: [{ card_id: "20000000-0000-4000-8000-000000000001", rating: "good" }],
    });
    expect(res.status).toBe(404);
  });

  test("a review naming a card outside the deck answers 422 VALIDATION_FAILED", async () => {
    const app = buildFlashcardApp({
      database: fakeDatabase({
        deck: { id: DECK_ID, student_id: STUDENT_ID },
        deckCards: [
          { id: "20000000-0000-4000-8000-000000000001", card_order: 1 },
          { id: "20000000-0000-4000-8000-000000000002", card_order: 2 },
        ],
      }).database,
    });

    const res = await postJson(app, reviewUrl, {
      reviews: [{ card_id: "40000000-0000-4000-8000-000000000000", rating: "good" }],
    });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("a duplicate review of the same card answers 400", async () => {
    const app = buildFlashcardApp({
      database: fakeDatabase({
        deck: { id: DECK_ID, student_id: STUDENT_ID },
        deckCards: [
          { id: "20000000-0000-4000-8000-000000000001", card_order: 1 },
          { id: "20000000-0000-4000-8000-000000000002", card_order: 2 },
        ],
      }).database,
    });

    const res = await postJson(app, reviewUrl, {
      reviews: [
        { card_id: "20000000-0000-4000-8000-000000000001", rating: "good" },
        { card_id: "20000000-0000-4000-8000-000000000001", rating: "again" },
      ],
    });
    expect(res.status).toBe(400);
  });

  test("advances SM-2 per card, persists the new schedules, and commits zero tokens", async () => {
    const handle = quotaHandle();
    const calls: LlmGenerateInput[] = [];
    const { database, queries } = fakeDatabase({
      deck: { id: DECK_ID, student_id: STUDENT_ID },
      deckCards: [
        { id: "20000000-0000-4000-8000-000000000001", card_order: 1 },
        { id: "20000000-0000-4000-8000-000000000002", card_order: 2 },
      ],
      progress: [
        {
          card_id: "20000000-0000-4000-8000-000000000002",
          interval_days: 15,
          ease_factor: 2.5,
          repetitions: 3,
          due_at: new Date("2026-01-14T09:00:00.000Z"),
        },
      ],
    });
    const app = buildFlashcardApp({
      provider: fakeProvider({ calls }),
      database,
      handle,
    });

    const res = await postJson(app, reviewUrl, {
      reviews: [
        { card_id: "20000000-0000-4000-8000-000000000001", rating: "good" },
        { card_id: "20000000-0000-4000-8000-000000000002", rating: "good" },
      ],
    });
    const body = (await res.json()) as {
      deck_id: string;
      reviewed_count: number;
      results: {
        card_id: string;
        rating: string;
        interval_days: number;
        ease_factor: number;
        repetitions: number;
        due_at: string;
      }[];
    };

    expect(res.status).toBe(200);
    expect(body.deck_id).toBe(DECK_ID);
    expect(body.reviewed_count).toBe(2);

    // A never-reviewed card rated good starts the ladder: 1 day, repetitions 1, ease factor 2.5.
    expect(body.results[0]).toMatchObject({
      card_id: "20000000-0000-4000-8000-000000000001",
      rating: "good",
      interval_days: 1,
      ease_factor: 2.5,
      repetitions: 1,
    });

    // A card at interval 15 / repetitions 3 rated good grows to round(15 * 2.5) = 38 days.
    expect(body.results[1]).toMatchObject({
      card_id: "20000000-0000-4000-8000-000000000002",
      rating: "good",
      interval_days: 38,
      ease_factor: 2.5,
      repetitions: 4,
    });

    // The review upserts ran, once per card.
    expect(queries.filter((q) => q.includes("INSERT INTO app.flashcard_reviews"))).toHaveLength(2);

    // No LLM call, and the reservation is settled at zero tokens.
    expect(calls).toHaveLength(0);
    expect(handle.commits).toEqual([0]);
  });

  test("a fail rating resets a matured card back to 1 day", async () => {
    const app = buildFlashcardApp({
      database: fakeDatabase({
        deck: { id: DECK_ID, student_id: STUDENT_ID },
        deckCards: [
          { id: "20000000-0000-4000-8000-000000000001", card_order: 1 },
          { id: "20000000-0000-4000-8000-000000000002", card_order: 2 },
        ],
        progress: [
          {
            card_id: "20000000-0000-4000-8000-000000000002",
            interval_days: 15,
            ease_factor: 2.5,
            repetitions: 3,
            due_at: new Date("2026-01-14T09:00:00.000Z"),
          },
        ],
      }).database,
    });

    const res = await postJson(app, reviewUrl, {
      reviews: [{ card_id: "20000000-0000-4000-8000-000000000002", rating: "again" }],
    });
    const body = (await res.json()) as {
      results: { interval_days: number; ease_factor: number; repetitions: number }[];
    };

    expect(res.status).toBe(200);
    expect(body.results[0]).toMatchObject({
      interval_days: 1,
      ease_factor: 1.96,
      repetitions: 0,
    });
  });
});
