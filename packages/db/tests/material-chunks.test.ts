import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_MODEL = "text-embedding-3-small";

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

// A deterministic unit-ish vector, so a test's nearest-neighbour ordering is reproducible rather than
// dependent on random(). Rotating the phase by `seed` walks the vector around the space, so two seeds
// that are close produce vectors that are close.
function vector(seed: number): string {
  const values = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    Math.sin((i + 1) * 0.001 + seed).toFixed(6),
  );
  return `[${values.join(",")}]`;
}

async function migratedDatabase(): Promise<Database> {
  const database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
  return database;
}

async function asRole<T>(
  database: Database,
  role: Role,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    result = await run(tx);
  });
  return result as T;
}

// Forced RLS binds studafy_admin too, so even admin paths carry a tenant context.
async function asSchool<T>(
  database: Database,
  school: string,
  run: (tx: TransactionSql) => Promise<T>,
  role: Role = "studafy_app",
): Promise<T> {
  return asRole(database, role, async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    return run(tx);
  });
}

async function expectFailure(
  database: Database,
  school: string | undefined,
  run: (tx: TransactionSql) => Promise<unknown>,
  role: Role = "studafy_app",
): Promise<{ code: string; message: string }> {
  try {
    await asRole(database, role, async (tx) => {
      if (school !== undefined) await tx`SELECT set_config('app.school_id', ${school}, true)`;
      await run(tx);
    });
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { code: failure.code ?? "", message: failure.message ?? "" };
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

interface Tenant {
  school: string;
  material: string;
}

// A material cannot exist without a class, and a class cannot exist without an academic year, term,
// subject, course, room, and lead teacher. The whole chain is built here so the tests below can talk
// about chunks rather than about scaffolding.
async function seedTenant(
  database: Database,
  slug: string,
  chunks: { count: number; content?: (index: number) => string; seed?: (index: number) => number },
): Promise<Tenant> {
  const [refs] = await database.sql<{ country: string; currency: string }[]>`
    SELECT (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
           (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;

  const school = await asRole(database, "studafy_admin", async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, ${slug}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`}, ${refs!.country}, ${refs!.currency})
      RETURNING id
    `;
    return row!.id;
  });

  const material = await asSchool(
    database,
    school,
    async (tx) => {
      const [year] = await tx<{ id: string }[]>`
        INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on)
        VALUES (${school}, 'AY26', 'Year 26', '2026-01-01', '2026-12-31') RETURNING id
      `;
      const [term] = await tx<{ id: string }[]>`
        INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on)
        VALUES (${school}, ${year!.id}, 'T1', 'Term 1', 1, '2026-01-01', '2026-06-30') RETURNING id
      `;
      const [subject] = await tx<{ id: string }[]>`
        INSERT INTO app.subjects (school_id, code, name)
        VALUES (${school}, 'SCI', 'Science') RETURNING id
      `;
      const [course] = await tx<{ id: string }[]>`
        INSERT INTO app.courses (school_id, subject_id, code, name)
        VALUES (${school}, ${subject!.id}, 'BIO', 'Biology') RETURNING id
      `;
      const [room] = await tx<{ id: string }[]>`
        INSERT INTO app.rooms (school_id, code, name, room_type, virtual_url)
        VALUES (${school}, 'R1', 'Room 1', 'virtual', 'https://meet.example.test/r1') RETURNING id
      `;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, status)
        VALUES (${school}, ${`${slug}@example.test`}, ${`${slug}@example.test`}, 'active') RETURNING id
      `;
      const [teacher] = await tx<{ id: string }[]>`
        INSERT INTO app.teachers (school_id, user_id, employee_number)
        VALUES (${school}, ${user!.id}, 'E1') RETURNING id
      `;
      const [klass] = await tx<{ id: string }[]>`
        INSERT INTO app.classes
          (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code)
        VALUES (${school}, ${course!.id}, ${year!.id}, ${term!.id}, ${teacher!.id}, ${room!.id}, 'C1')
        RETURNING id
      `;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.materials
          (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title,
           storage_key, original_file_name, mime_type, size_bytes)
        VALUES (${school}, ${klass!.id}, ${user!.id}, ${user!.id}, 'Biology Notes',
                ${`permanent/${school}/notes/1`}, 'notes.pdf', 'application/pdf', 1024)
        RETURNING id
      `;
      return row!.id;
    },
    "studafy_admin",
  );

  if (chunks.count > 0) {
    await asSchool(database, school, async (tx) => {
      for (let index = 0; index < chunks.count; index += 1) {
        const content = chunks.content?.(index) ?? `${slug} photosynthesis chunk ${index}`;
        const embedding = vector(chunks.seed?.(index) ?? index);
        await tx`
          INSERT INTO app.material_chunks
            (school_id, material_id, chunk_index, content, page_number, section_title,
             embedding, embedding_model)
          VALUES (${school}, ${material}, ${index}, ${content}, ${index + 1}, 'Chapter 1',
                  ${embedding}::public.vector, ${EMBEDDING_MODEL})
        `;
      }
    });
  }

  return { school, material };
}

integrationTest(
  "installs the chunk schema, both retrieval indexes, forced RLS, and the canonical policy",
  async () => {
    const database = await migratedDatabase();
    try {
      const [table] = await database.sql<
        {
          owner: string;
          rls: boolean;
          forced: boolean;
          policy: string;
          app_crud: boolean;
          public_any: boolean;
        }[]
      >`
        SELECT pg_get_userbyid(c.relowner) AS owner,
               c.relrowsecurity AS rls,
               c.relforcerowsecurity AS forced,
               (SELECT count(*)::text FROM pg_policy p
                 WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy,
               has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_crud,
               has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS public_any
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = 'material_chunks'
      `;
      expect(table).toEqual({
        owner: "studafy_admin",
        rls: true,
        forced: true,
        policy: "1",
        app_crud: true,
        public_any: false,
      });

      // The embedding column is exactly vector(1536): the dimension is enforced by the type, not by a
      // check constraint or by application convention.
      const [embedding] = await database.sql<{ type: string }[]>`
        SELECT format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a
        WHERE a.attrelid = 'app.material_chunks'::regclass AND a.attname = 'embedding'
      `;
      expect(embedding!.type).toBe(`vector(${EMBEDDING_DIMENSIONS})`);

      // content_tsv is GENERATED ... STORED, so it cannot drift from content and cannot be written to.
      const [generated] = await database.sql<{ generated: string; expression: string | null }[]>`
        SELECT a.attgenerated::text AS generated,
               pg_get_expr(d.adbin, d.adrelid) AS expression
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'app.material_chunks'::regclass AND a.attname = 'content_tsv'
      `;
      expect(generated!.generated).toBe("s");
      expect(generated!.expression).toContain("to_tsvector");

      // Exactly five indexes: the primary key, the two tenant-checked unique constraints, and the two
      // retrieval indexes. There is deliberately no sixth on (school_id, material_id, chunk_index) --
      // uq_material_chunks_material_chunk already is that btree, and a second copy would be redundant.
      const indexes = await database.sql<
        { name: string; method: string; options: string[] | null }[]
      >`
        SELECT i.relname AS name, am.amname AS method, i.reloptions AS options
        FROM pg_class t
        JOIN pg_index x ON x.indrelid = t.oid
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_am am ON am.oid = i.relam
        WHERE t.oid = 'app.material_chunks'::regclass
        ORDER BY i.relname
      `;
      expect([...indexes]).toEqual([
        { name: "idx_material_chunks_content_tsv", method: "gin", options: null },
        {
          name: "idx_material_chunks_embedding_hnsw",
          method: "hnsw",
          options: ["m=16", "ef_construction=64"],
        },
        { name: "pk_material_chunks", method: "btree", options: null },
        { name: "uq_material_chunks_id_school", method: "btree", options: null },
        { name: "uq_material_chunks_material_chunk", method: "btree", options: null },
      ]);
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "keeps content_tsv in step with content, and refuses a direct write to it",
  async () => {
    const database = await migratedDatabase();
    try {
      const { school, material } = await seedTenant(database, "tsv-tenant", { count: 0 });

      const [row] = await asSchool(
        database,
        school,
        (tx) => tx<{ id: string; tsv: string }[]>`
          INSERT INTO app.material_chunks
            (school_id, material_id, chunk_index, content, embedding, embedding_model)
          VALUES (${school}, ${material}, 0, 'Mitochondria produce cellular energy',
                  ${vector(1)}::public.vector, ${EMBEDDING_MODEL})
          RETURNING id, content_tsv::text AS tsv
        `,
      );
      // Stemmed and position-tagged by to_tsvector('english', ...), with the stop word removed.
      expect(row!.tsv).toContain("mitochondria");
      expect(row!.tsv).toContain("cellular");
      expect(row!.tsv).not.toContain("produce'"); // stemmed to "produc"

      // Updating content regenerates the tsvector. No trigger is involved and none can be forgotten.
      const [updated] = await asSchool(
        database,
        school,
        (tx) => tx<{ tsv: string }[]>`
          UPDATE app.material_chunks SET content = 'Chloroplasts perform photosynthesis'
          WHERE id = ${row!.id}
          RETURNING content_tsv::text AS tsv
        `,
      );
      expect(updated!.tsv).toContain("chloroplast");
      expect(updated!.tsv).not.toContain("mitochondria");

      // A generated column cannot be written to directly -- which is the whole reason it is generated.
      const direct = await expectFailure(
        database,
        school,
        (tx) => tx`
          UPDATE app.material_chunks SET content_tsv = to_tsvector('english', 'forged')
          WHERE id = ${row!.id}
        `,
      );
      expect(direct.code).toBe("428C9");
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "enforces the chunk keys, the tenant-safe material reference, and the payload constraints",
  async () => {
    const database = await migratedDatabase();
    try {
      const a = await seedTenant(database, "keys-a", { count: 1 });
      const b = await seedTenant(database, "keys-b", { count: 1 });

      const insert = (
        tx: TransactionSql,
        school: string,
        material: string,
        index: number,
        content = "valid content",
        embedding = vector(9),
        model = EMBEDDING_MODEL,
      ) => tx`
        INSERT INTO app.material_chunks
          (school_id, material_id, chunk_index, content, embedding, embedding_model)
        VALUES (${school}, ${material}, ${index}, ${content},
                ${embedding}::public.vector, ${model})
      `;

      // One chunk per (material, ordinal).
      const duplicate = await expectFailure(database, a.school, (tx) =>
        insert(tx, a.school, a.material, 0),
      );
      expect(duplicate.code).toBe("23505");

      // The composite foreign key stops a chunk pointing at another school's material. This is a schema
      // guarantee, not an RLS one: it holds even where RLS does not run.
      const crossTenant = await expectFailure(database, a.school, (tx) =>
        insert(tx, a.school, b.material, 1),
      );
      expect(crossTenant.code).toBe("23503");

      const negativeIndex = await expectFailure(database, a.school, (tx) =>
        insert(tx, a.school, a.material, -1),
      );
      expect(negativeIndex.code).toBe("23514");

      const blankContent = await expectFailure(database, a.school, (tx) =>
        insert(tx, a.school, a.material, 1, "   "),
      );
      expect(blankContent.code).toBe("23514");

      const blankModel = await expectFailure(database, a.school, (tx) =>
        insert(tx, a.school, a.material, 1, "valid content", vector(9), " "),
      );
      expect(blankModel.code).toBe("23514");

      // The dimension is enforced by the type. A 3-dimensional vector is not a 1536-dimensional one.
      const wrongDimension = await expectFailure(database, a.school, (tx) =>
        insert(tx, a.school, a.material, 1, "valid content", "[1,2,3]"),
      );
      expect(wrongDimension.code).toBe("22000");

      // Deleting a material takes its chunks with it. Chunks are derived data with no independent
      // existence, and an embedding of a deleted document must not survive to be retrieved and quoted.
      await asSchool(
        database,
        a.school,
        (tx) => tx`DELETE FROM app.materials WHERE id = ${a.material}`,
        "studafy_admin",
      );
      const [remaining] = await asSchool(
        database,
        a.school,
        (tx) => tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.material_chunks`,
      );
      expect(remaining!.count).toBe("0");
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

integrationTest(
  "isolates tenants across the vector, full-text, and hybrid retrieval paths",
  async () => {
    const database = await migratedDatabase();
    try {
      // School B dominates the corpus. If tenant isolation were applied anywhere other than the row
      // level -- or if a retrieval path bypassed the policy -- B's chunks would swamp A's results.
      const a = await seedTenant(database, "rls-a", {
        count: 20,
        content: (i) => `alpha photosynthesis chloroplast lesson ${i}`,
        seed: (i) => i * 0.01,
      });
      const b = await seedTenant(database, "rls-b", {
        count: 400,
        content: (i) => `beta photosynthesis chloroplast lesson ${i}`,
        seed: (i) => i * 0.01,
      });
      await database.sql`ANALYZE app.material_chunks`;

      const query = vector(0.05);

      // 1. Vector distance. Every row the ANN path returns belongs to the acting school.
      const semantic = await asSchool(
        database,
        a.school,
        (tx) => tx<{ school_id: string; content: string }[]>`
          SELECT school_id, content FROM app.material_chunks
          ORDER BY embedding <=> ${query}::public.vector
          LIMIT 10
        `,
      );
      expect(semantic).toHaveLength(10);
      expect(new Set(semantic.map((r) => r.school_id))).toEqual(new Set([a.school]));
      for (const row of semantic) expect(row.content).toStartWith("alpha");

      // 2. Full-text. Both schools' chunks match the same tsquery, so any leak would show up here.
      const keyword = await asSchool(
        database,
        a.school,
        (tx) => tx<{ school_id: string; content: string }[]>`
          SELECT school_id, content FROM app.material_chunks
          WHERE content_tsv @@ websearch_to_tsquery('english', 'photosynthesis chloroplast')
          LIMIT 50
        `,
      );
      expect(keyword.length).toBeGreaterThan(0);
      expect(new Set(keyword.map((r) => r.school_id))).toEqual(new Set([a.school]));

      // 3. The RRF hybrid, exactly as the application will issue it. Both legs are filtered
      //    independently, so the fused result cannot contain another school's chunk.
      const hybrid = await asSchool(database, a.school, async (tx) => {
        await tx.unsafe("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
        return tx<{ school_id: string; content: string; rrf: number }[]>`
          WITH semantic AS (
            SELECT id, row_number() OVER (ORDER BY embedding <=> ${query}::public.vector) AS rank
            FROM app.material_chunks
            ORDER BY embedding <=> ${query}::public.vector
            LIMIT 50
          ), keyword AS (
            SELECT c.id,
                   row_number() OVER (ORDER BY ts_rank(c.content_tsv, q.query) DESC) AS rank
            FROM app.material_chunks c,
                 websearch_to_tsquery('english', 'photosynthesis chloroplast') AS q(query)
            WHERE c.content_tsv @@ q.query
            ORDER BY ts_rank(c.content_tsv, q.query) DESC
            LIMIT 50
          ), fused AS (
            SELECT COALESCE(s.id, k.id) AS id,
                   COALESCE(1.0 / (60 + s.rank), 0) + COALESCE(1.0 / (60 + k.rank), 0) AS rrf
            FROM semantic s FULL OUTER JOIN keyword k ON k.id = s.id
          )
          SELECT c.school_id, c.content, f.rrf
          FROM fused f JOIN app.material_chunks c ON c.id = f.id
          ORDER BY f.rrf DESC
          LIMIT 10
        `;
      });
      expect(hybrid).toHaveLength(10);
      expect(new Set(hybrid.map((r) => r.school_id))).toEqual(new Set([a.school]));
      for (const row of hybrid) expect(row.content).toStartWith("alpha");
      // RRF fuses two ranks, so a chunk found by both legs must outscore one found by a single leg.
      expect(Number(hybrid[0]!.rrf)).toBeGreaterThan(1 / (60 + 1));

      // 4. Fail closed. No tenant context, or a malformed one, retrieves nothing -- it raises.
      for (const context of [undefined, "", "not-a-uuid"]) {
        const denied = await expectFailure(
          database,
          context,
          (tx) => tx`
            SELECT id FROM app.material_chunks
            ORDER BY embedding <=> ${query}::public.vector LIMIT 5
          `,
        );
        expect(denied.code).not.toBe("");
      }

      // 5. A cross-tenant write is rejected outright, not silently retenanted. B's ids are named as
      //    literals rather than selected: a SELECT feeding the INSERT would itself be RLS-filtered to
      //    nothing, and inserting zero rows is not the same thing as being refused.
      const forged = await expectFailure(
        database,
        a.school,
        (tx) => tx`
          INSERT INTO app.material_chunks
            (school_id, material_id, chunk_index, content, embedding, embedding_model)
          VALUES (${b.school}, ${b.material}, 999, 'forged',
                  ${vector(3)}::public.vector, ${EMBEDDING_MODEL})
        `,
      );
      // 42501: the tenant policy's WITH CHECK refuses a row belonging to another school.
      expect(forged.code).toBe("42501");
    } finally {
      await database.cleanup();
    }
  },
  120_000,
);
