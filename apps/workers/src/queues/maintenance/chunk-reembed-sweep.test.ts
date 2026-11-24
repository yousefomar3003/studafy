/**
 * The chunk re-embed sweep (ADR-021), against a real database.
 *
 * Seeds one class material with chunks under the mock model and one already under the live model.
 * Proves: the sweep relabels and re-vectors every stale chunk from its stored content, leaves the
 * live one alone, does nothing on a second run, and a provider failure leaves the rows as they
 * were. Skipped unless TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, mockEmbedding } from "../ai-ingestion/embedding";

import { reembedStaleChunks } from "./chunk-reembed-sweep";

import type { EmbeddingProvider } from "../ai-ingestion/embedding";
import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const sweepTest = test.skipIf(!databaseUrl);

const LIVE_MODEL = "test/live-embedding@1536";

let sql: Sql | undefined;
const seededSchools: string[] = [];

beforeAll(() => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  if (!sql) return;
  for (const schoolId of seededSchools) {
    await sql
      .begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
        await tx`DELETE FROM app.material_chunks WHERE school_id = ${schoolId}::uuid`;
      })
      .catch(() => undefined);
  }
  await sql.end({ timeout: 5 });
});

/** A live provider whose vector is a constant, so a re-embedded row is recognizable. */
function liveProvider(calls: string[][] = []): EmbeddingProvider {
  const vector = `[${Array.from({ length: EMBEDDING_DIMENSIONS }, () => "0.5").join(",")}]`;
  return {
    model: LIVE_MODEL,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map(() => vector);
    },
  };
}

function asSchool<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** A school with one AI-enabled class material holding `stale` mock chunks and one live chunk. */
async function seedMaterial(stale: number): Promise<{ schoolId: string; liveChunkId: string }> {
  const tag = `reembed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const seeded = await sql!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
             (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`School ${tag}`}, ${`${tag}@admin.local`}, ${`${tag}@admin.local`},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`t-${tag}@t.local`}, ${`t-${tag}@t.local`}, 'Teacher', 'active')
      RETURNING id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${schoolId}::uuid, ${user!.id}::uuid, ${`EMP-${tag}`}, 'active')
      RETURNING id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${`AY-${tag}`}, ${`AY ${tag}`}, '2026-01-01'::date, '2026-12-31'::date, 'active')
      RETURNING id
    `;
    const [term] = await tx<{ id: string }[]>`
      INSERT INTO app.terms
        (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${`T-${tag}`}, ${`T ${tag}`}, 1::smallint,
              '2026-01-01'::date, '2026-06-30'::date, 'active')
      RETURNING id
    `;
    const [subject] = await tx<{ id: string }[]>`
      INSERT INTO app.subjects (school_id, code, name, status)
      VALUES (${schoolId}::uuid, ${`SUB-${tag}`}, ${`Subject ${tag}`}, 'active')
      RETURNING id
    `;
    const [course] = await tx<{ id: string }[]>`
      INSERT INTO app.courses (school_id, subject_id, code, name, credit_hours, status)
      VALUES (${schoolId}::uuid, ${subject!.id}::uuid, ${`CRS-${tag}`}, ${`Course ${tag}`}, 1, 'active')
      RETURNING id
    `;
    const [room] = await tx<{ id: string }[]>`
      INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
      VALUES (${schoolId}::uuid, ${`RM-${tag}`}, ${`Room ${tag}`}, 'physical', 30, 'Main')
      RETURNING id
    `;
    const [cls] = await tx<{ id: string }[]>`
      INSERT INTO app.classes
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity,
         status, ai_materials_enabled)
      VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
              ${teacher!.id}::uuid, ${room!.id}::uuid, ${`CLS-${tag}`}, 32, 'active', true)
      RETURNING id
    `;
    const [material] = await tx<{ id: string }[]>`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
         storage_key, original_file_name, mime_type, size_bytes, ai_visible, ingest_status,
         ingested_at)
      VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${user!.id}::uuid, ${user!.id}::uuid, 'Biology',
              ${`permanent/${schoolId}/materials/${tag}.docx`}, 'bio.docx',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 100,
              true, 'ready', CURRENT_TIMESTAMP)
      RETURNING id
    `;
    const rows = [
      ...Array.from({ length: stale }, (_, index) => ({
        content: `البناء الضوئي فقرة ${index}`,
        embedding: mockEmbedding(`chunk ${index}`),
        embedding_model: EMBEDDING_MODEL,
      })),
      {
        content: "Already on the live model.",
        embedding: mockEmbedding("live"),
        embedding_model: LIVE_MODEL,
      },
    ].map((row, index) => ({
      school_id: schoolId,
      material_id: material!.id,
      chunk_index: index,
      ...row,
    }));
    const inserted: { id: string; embedding_model: string }[] = [];
    for (const row of rows) {
      const [chunk] = await tx<{ id: string; embedding_model: string }[]>`
        INSERT INTO app.material_chunks
          (school_id, material_id, chunk_index, content, embedding, embedding_model)
        VALUES (${row.school_id}::uuid, ${row.material_id}::uuid, ${row.chunk_index}, ${row.content},
                ${row.embedding}::public.vector, ${row.embedding_model})
        RETURNING id, embedding_model
      `;
      inserted.push(chunk!);
    }
    return {
      schoolId,
      liveChunkId: inserted.find((row) => row.embedding_model === LIVE_MODEL)!.id,
    };
  });
  seededSchools.push(seeded.schoolId);
  return seeded;
}

function chunksOf(schoolId: string) {
  return asSchool(
    schoolId,
    (tx) =>
      tx<{ id: string; embedding_model: string; first: string }[]>`
      SELECT id, embedding_model, split_part(trim(both '[]' from embedding::text), ',', 1) AS first
      FROM app.material_chunks
      WHERE school_id = ${schoolId}::uuid
      ORDER BY chunk_index
    `,
  );
}

describe("reembedStaleChunks", () => {
  sweepTest(
    "re-embeds every stale chunk from its content, in batches, and only those",
    async () => {
      const { schoolId, liveChunkId } = await seedMaterial(5);
      const before = await chunksOf(schoolId);
      const liveBefore = before.find((row) => row.id === liveChunkId)!;
      const calls: string[][] = [];

      const result = await reembedStaleChunks(sql!, liveProvider(calls), undefined, {
        batchSize: 2,
      });

      expect(result.failed).toBe(0);
      expect(result.reembedded).toBeGreaterThanOrEqual(5);
      const after = await chunksOf(schoolId);
      expect(after.every((row) => row.embedding_model === LIVE_MODEL)).toBe(true);
      for (const row of after) {
        if (row.id === liveChunkId) expect(row.first).toBe(liveBefore.first);
        else expect(Number(row.first)).toBe(0.5);
      }
      // The stored content is what gets embedded.
      expect(calls.flat()).toContain("البناء الضوئي فقرة 0");

      const again = await reembedStaleChunks(sql!, liveProvider(), undefined, { batchSize: 2 });
      const mine = (await chunksOf(schoolId)).filter((row) => row.id !== liveChunkId);
      expect(mine.every((row) => Number(row.first) === 0.5)).toBe(true);
      expect(again.failed).toBe(0);
    },
  );

  sweepTest("a provider failure leaves the rows on their old vectors and is counted", async () => {
    const { schoolId } = await seedMaterial(2);
    const down: EmbeddingProvider = {
      model: "test/down-embedding@1536",
      embed: async () => {
        throw new Error("provider down");
      },
    };

    const result = await reembedStaleChunks(sql!, down);

    expect(result.failed).toBeGreaterThanOrEqual(1);
    const rows = await chunksOf(schoolId);
    expect(rows.filter((row) => row.embedding_model === EMBEDDING_MODEL)).toHaveLength(2);
  });

  sweepTest("a run stops at its budget", async () => {
    await seedMaterial(3);
    const result = await reembedStaleChunks(sql!, liveProvider(), undefined, {
      batchSize: 2,
      maxPerRun: 2,
    });
    expect(result.reembedded).toBeLessThanOrEqual(2);
  });
});
