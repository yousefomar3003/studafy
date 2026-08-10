/**
 * ST-162 hybrid retrieval route — live-PostgreSQL integration test.
 *
 * Mounts the real route on a real tenant transaction and asserts the properties
 * `docs/rag/hybrid-search-and-rag-storage.md` makes load-bearing:
 *
 *   - both legs are RLS-filtered, so a fused result cannot contain another school's chunk even when
 *     a foreign chunk matches the same keyword query (the "tenant-pure" guard);
 *   - the semantic leg is asserted on its own terms (`meta.semantic_leg_count`), never hidden behind
 *     Reciprocal Rank Fusion;
 *   - a keyword-unique chunk ranks above semantic-only hits and carries its citation anchors
 *     (material title, page, section);
 *   - the route records the query's token cost durably in `app.ai_usage_meters` for the metered
 *     student.
 *
 * The AI entitlement gate's refusal codes (403/402/429) are covered by
 * `gate/entitlement-gate.test.ts`; here the route is mounted with a ready aiQuota handle — exactly
 * what the gate attaches in production. One test mounts it without the handle to pin the wiring
 * invariant that the retrieval surface must never run un-metered.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/ai/routes/retrieval-routes.integration.test.ts
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  createFullTenant,
  createMaterial,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TenantFixture,
  type TestDatabase,
} from "../../../../tests/harness";
import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  createDeterministicQueryEmbedder,
  estimateQueryTokens,
  RETRIEVAL_EMBEDDING_MODEL,
} from "../retrieval/embeddings";
import { HYBRID_LEG_LIMIT } from "../retrieval/search";

import { aiRetrievalRoutes } from "./retrieval-routes";

import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { AiQuotaHandle } from "../gate/entitlement-gate";
import type { TransactionSql } from "postgres";

const RETRIEVAL_DIMENSIONS = 1536;

const describeDb = integrationEnabled ? describe : describe.skip;

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

let db: TestDatabase;
let adminClient: ReturnType<typeof postgres> | undefined;
let tenantClient: ReturnType<typeof postgres> | undefined;
let tenant: TenantFixture;
let auth: AuthContext;
let retrievalApp: OpenAPIHono<AppEnv>;
let materialId: string;
let tenantChunkIds: string[];
let foreignChunkId: string;

/**
 * A deterministic, unit-scale pseudo-embedding, byte-identical in shape to the corpus seed's
 * (`db/seeds/support.ts` `deterministicEmbedding`): 1536 finite floats, distinct per seed so the
 * ANN graph never collapses to one point.
 */
function chunkEmbedding(seed: number): string {
  const parts = Array.from({ length: RETRIEVAL_DIMENSIONS }, (_, index) =>
    Math.sin(seed * 0.017 + index * 0.013).toFixed(6),
  );
  return `[${parts.join(",")}]`;
}

function quotaHandle(): AiQuotaHandle {
  return {
    reservationId: "res-retrieval",
    reservedTokens: 5,
    settled: false,
    async commit(consumed) {
      return { settled: true, remaining: 1000 - consumed };
    },
    async release() {
      return { settled: true, remaining: 1000 };
    },
  };
}

function buildRetrievalApp(handle: AiQuotaHandle): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    c.set("aiQuota", handle);
    await next();
  });
  app.route(
    "/",
    aiRetrievalRoutes({ database: tenantClient!, embedder: createDeterministicQueryEmbedder() }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

/** Seed a scoped row the way the fixtures do: school GUC first, then studafy_admin. */
async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await adminClient!.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

async function seedChunk(args: {
  schoolId: string;
  materialId: string;
  chunkIndex: number;
  content: string;
  pageNumber?: number;
  sectionTitle?: string;
}): Promise<string> {
  return asAdmin(args.schoolId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.material_chunks
        (school_id, material_id, chunk_index, content, page_number, section_title,
         embedding, embedding_model)
      VALUES (
        ${args.schoolId}, ${args.materialId}, ${args.chunkIndex}, ${args.content},
        ${args.pageNumber ?? null}, ${args.sectionTitle ?? null},
        ${chunkEmbedding(args.chunkIndex + 1)}::public.vector, ${RETRIEVAL_EMBEDDING_MODEL}
      )
      RETURNING id
    `;
    return row!.id;
  });
}

async function seedAiSubscription(schoolId: string, studentId: string): Promise<void> {
  await asAdmin(schoolId, async (tx) => {
    await tx`
      INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
      VALUES (${schoolId}, ${studentId}, 'active', '2026-08-01T00:00:00Z', '2026-08-31T00:00:00Z')
    `;
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  // bun 1.3.14 + postgres.js: a pooled `sql.begin` issued after seeding can hang — the same
  // environment note as material-toggle.integration.test.ts. Route every BEGIN through pinned single
  // connections and split admin seeding from tenant transactions.
  adminClient = postgres(db.url, { max: 1, prepare: false });
  tenantClient = postgres(db.url, { max: 1, prepare: false });

  tenant = await createFullTenant(db.sql);
  const material = await createMaterial(db.sql, tenant.schoolId, {
    classId: tenant.cls.id,
    uploadedByUserId: tenant.teachers[0]!.userId,
    title: "Physics Notes",
  });
  materialId = material.id;

  tenantChunkIds = [
    await seedChunk({
      schoolId: tenant.schoolId,
      materialId: material.id,
      chunkIndex: 0,
      content: "Zirconium metallurgical alloys provide corrosion resistance in nuclear cladding.",
      pageNumber: 12,
      sectionTitle: "Material Properties",
    }),
    await seedChunk({
      schoolId: tenant.schoolId,
      materialId: material.id,
      chunkIndex: 1,
      content: "Photosynthesis converts light energy into chemical energy inside chloroplasts.",
    }),
  ];

  // A second tenant whose chunk matches the same keyword query, so the tenant-pure guard has
  // something real to refuse.
  const foreign = await createFullTenant(db.sql);
  const foreignMaterial = await createMaterial(db.sql, foreign.schoolId, {
    classId: foreign.cls.id,
    uploadedByUserId: foreign.teachers[0]!.userId,
    title: "Foreign Notes",
  });
  foreignChunkId = await seedChunk({
    schoolId: foreign.schoolId,
    materialId: foreignMaterial.id,
    chunkIndex: 0,
    content: "Zirconium metallurgical corrosion resistance is studied in marine laboratories.",
  });

  auth = {
    // The acting user is the *enrolled student account* (`tenant.students[0].userId`), not the
    // STUDENT-role fixture user (`tenant.users.STUDENT.id`): `can_read_class` resolves the acting
    // user from `app.user_id` against the student row, so only the account actually enrolled in the
    // class can see the material that the fused hits join to.
    userId: tenant.students[0]!.userId,
    schoolId: tenant.schoolId,
    roles: [ROLES.STUDENT],
    channel: AUTH_CHANNELS.API,
    jti: "jti-retrieval",
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };

  await seedAiSubscription(tenant.schoolId, tenant.students[0]!.id);
  retrievalApp = buildRetrievalApp(quotaHandle());
});

afterAll(async () => {
  if (tenantClient) await tenantClient.end({ timeout: 1 });
  if (adminClient) await adminClient.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

describeDb("POST /api/ai/students/{studentId}/search", () => {
  test("returns fused hits with citation anchors and asserted semantic-leg telemetry", async () => {
    const query = "zirconium metallurgical corrosion resistance";
    const res = await retrievalApp.request(`/api/ai/students/${tenant.students[0]!.id}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: string;
      results: {
        chunk_id: string;
        material_id: string;
        material_title: string | null;
        page_number: number | null;
        section_title: string | null;
        rrf_score: number;
        semantic_rank: number | null;
        keyword_rank: number | null;
      }[];
      meta: { semantic_leg_count: number; retried: boolean; tokens_used: number };
    };

    expect(body.query).toBe(query);
    expect(body.results.length).toBeGreaterThan(0);

    // The semantic leg is asserted on its own terms: it returned exactly the tenant's two chunks,
    // because RLS filtered the foreign tenant's rows out of the ANN path before fusion could hide it.
    expect(body.meta.semantic_leg_count).toBe(2);
    // A leg shorter than HYBRID_LEG_LIMIT always triggers the single bounded ef_search retry, so for
    // this small tenant the retry flag is the contract being exercised, not an anomaly.
    expect(body.meta.retried).toBe(body.meta.semantic_leg_count < HYBRID_LEG_LIMIT);
    expect(body.meta.tokens_used).toBe(estimateQueryTokens(query));

    // The keyword-unique chunk is present, ranked 1 by the FTS leg, carrying its citation anchors.
    const zirconium = body.results.find((hit) => hit.chunk_id === tenantChunkIds[0]);
    expect(zirconium).toBeDefined();
    expect(zirconium!.keyword_rank).toBe(1);
    expect(zirconium!.semantic_rank).not.toBeNull();
    expect(zirconium!.material_title).toBe("Physics Notes");
    expect(zirconium!.page_number).toBe(12);
    expect(zirconium!.section_title).toBe("Material Properties");

    // The semantic-only chunk is present with no keyword rank.
    const semanticOnly = body.results.find((hit) => hit.chunk_id === tenantChunkIds[1]);
    expect(semanticOnly).toBeDefined();
    expect(semanticOnly!.keyword_rank).toBeNull();
    expect(semanticOnly!.semantic_rank).not.toBeNull();

    // RRF ordering: the keyword-plus-semantic hit outranks the semantic-only hit.
    expect(zirconium!.rrf_score).toBeGreaterThan(semanticOnly!.rrf_score);

    // Tenant purity: the foreign chunk matched the same keyword query and still cannot appear, and
    // every hit is the acting school's own material.
    expect(body.results.map((hit) => hit.chunk_id)).not.toContain(foreignChunkId);
    expect(body.results.every((hit) => hit.material_id === materialId)).toBe(true);
  });

  test("records the query's token cost durably for the metered student", async () => {
    const q1 = "zirconium metallurgical corrosion resistance";
    const q2 = "photosynthesis chloroplast light energy";

    // Read the meter before running, so the assertion is a durable delta rather than an absolute
    // that earlier tests in this file would have already accumulated into.
    const before = await asAdmin(tenant.schoolId, async (tx) => {
      const [row] = await tx<{ total_tokens: string }[]>`
        SELECT total_tokens
        FROM app.ai_usage_meters
        WHERE school_id = ${tenant.schoolId}::uuid AND student_id = ${tenant.students[0]!.id}::uuid
      `;
      return row ? Number(row.total_tokens) : 0;
    });

    for (const query of [q1, q2]) {
      const res = await retrievalApp.request(`/api/ai/students/${tenant.students[0]!.id}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      expect(res.status).toBe(200);
    }

    const after = await asAdmin(tenant.schoolId, async (tx) => {
      const [row] = await tx<{ total_tokens: string }[]>`
        SELECT total_tokens
        FROM app.ai_usage_meters
        WHERE school_id = ${tenant.schoolId}::uuid AND student_id = ${tenant.students[0]!.id}::uuid
      `;
      return row ? Number(row.total_tokens) : 0;
    });

    expect(after - before).toBe(estimateQueryTokens(q1) + estimateQueryTokens(q2));
  });

  test("rejects an out-of-range limit and a blank query with 400", async () => {
    const url = `/api/ai/students/${tenant.students[0]!.id}/search`;

    const outOfRange = await retrievalApp.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "zirconium", limit: 25 }),
    });
    expect(outOfRange.status).toBe(400);

    const blank = await retrievalApp.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "   " }),
    });
    expect(blank.status).toBe(400);
  });

  test("fails loud when the route runs without an aiQuota handle", async () => {
    const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
    app.use("*", async (c, next) => {
      c.set("auth", auth);
      c.set("locale", "en");
      await next();
    });
    app.route(
      "/",
      aiRetrievalRoutes({ database: tenantClient!, embedder: createDeterministicQueryEmbedder() }),
    );
    app.onError(errorHandlerMiddleware(silentLogger));

    const res = await app.request(`/api/ai/students/${tenant.students[0]!.id}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "zirconium" }),
    });
    expect(res.status).toBe(500);
  });
});
