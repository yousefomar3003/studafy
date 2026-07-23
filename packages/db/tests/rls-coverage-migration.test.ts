import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, migrationFixture, runnerEnv, testDatabase } from "./helpers";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

async function migrationFilesThrough(maximumVersion: number): Promise<Record<string, string>> {
  // The directory is a repository-owned constant, not user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const names = (await readdir(repositoryMigrations))
    .filter((name) => Number(name.slice(0, 6)) <= maximumVersion)
    .sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        // Filenames came from the repository directory and are consumed as read-only fixtures.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await readFile(resolve(repositoryMigrations, name), "utf8"),
      ]),
    ),
  );
}

integrationTest(
  "citation normalization preserves valid order and duplicates while omitting invalid tenant links",
  async () => {
    const fixture = await migrationFixture(await migrationFilesThrough(22));
    const database = await testDatabase();
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, fixture.directory),
        log: () => undefined,
      });

      const schoolA = crypto.randomUUID();
      const schoolB = crypto.randomUUID();
      const conversationA = crypto.randomUUID();
      const messageA = crypto.randomUUID();
      const chunkA1 = crypto.randomUUID();
      const chunkA2 = crypto.randomUUID();
      const chunkB = crypto.randomUUID();
      const staleChunk = crypto.randomUUID();

      // Build the smallest pre-000023 historical fixture. Trigger-backed foreign keys unrelated to
      // citation normalization are disabled only on this reserved superuser test connection; the
      // school, message, and chunk rows referenced by the new constraints all physically exist.
      const reserved = await database.sql.reserve();
      try {
        // eslint-disable-next-line studafy/no-session-set -- reserved superuser connection, not pooled
        await reserved.unsafe("SET session_replication_role = replica");
        await reserved`
          INSERT INTO app.schools (id, slug, name, country_id, default_currency_id)
          VALUES
            (${schoolA}, 'st050-school-a', 'ST050 School A', gen_random_uuid(), gen_random_uuid()),
            (${schoolB}, 'st050-school-b', 'ST050 School B', gen_random_uuid(), gen_random_uuid())
        `;
        await reserved`
          INSERT INTO app.ai_conversations (id, school_id, student_id, model)
          VALUES (${conversationA}, ${schoolA}, ${crypto.randomUUID()}, 'test-model')
        `;
        await reserved`
          INSERT INTO app.material_chunks (
            id, school_id, material_id, chunk_index, content, embedding, embedding_model
          ) VALUES
            (${chunkA1}, ${schoolA}, ${crypto.randomUUID()}, 0, 'chunk a1',
             array_fill(0::real, ARRAY[1536])::public.vector, 'test-model'),
            (${chunkA2}, ${schoolA}, ${crypto.randomUUID()}, 1, 'chunk a2',
             array_fill(0::real, ARRAY[1536])::public.vector, 'test-model'),
            (${chunkB}, ${schoolB}, ${crypto.randomUUID()}, 0, 'chunk b',
             array_fill(0::real, ARRAY[1536])::public.vector, 'test-model')
        `;
        await reserved`
          INSERT INTO app.ai_messages (
            id, school_id, conversation_id, question, answer, cited_chunk_ids,
            prompt_tokens, completion_tokens, total_tokens, expires_at
          ) VALUES (
            ${messageA}, ${schoolA}, ${conversationA}, 'question', 'answer',
            ARRAY[${chunkA1}, ${staleChunk}, ${chunkB}, ${chunkA1}, ${chunkA2}]::uuid[],
            10, 5, 15, now() + interval '90 days'
          )
        `;
      } finally {
        // eslint-disable-next-line studafy/no-session-set -- restore after trigger bypass
        await reserved.unsafe("SET session_replication_role = origin");
        reserved.release();
      }

      for (const name of [
        "000023_normalize_ai_message_citations.sql",
        "000024_add_notification_preferences_school_index.sql",
      ]) {
        // Both destinations live under the fresh test-only migration fixture directory.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await writeFile(
          resolve(fixture.directory, name),
          // The fixed names above select repository-owned migration input.
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          await readFile(resolve(repositoryMigrations, name), "utf8"),
        );
      }
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, fixture.directory),
        log: () => undefined,
      });

      const citations = await database.sql<{ material_chunk_id: string; citation_order: number }[]>`
        SELECT material_chunk_id, citation_order
        FROM app.ai_message_citations
        WHERE school_id = ${schoolA} AND ai_message_id = ${messageA}
        ORDER BY citation_order
      `;
      expect(Array.from(citations)).toEqual([
        { material_chunk_id: chunkA1, citation_order: 1 },
        { material_chunk_id: chunkA1, citation_order: 4 },
        { material_chunk_id: chunkA2, citation_order: 5 },
      ]);

      const [shape] = await database.sql<
        {
          old_column_exists: boolean;
          rls: boolean;
          forced: boolean;
          foreign_keys: string;
        }[]
      >`
        SELECT
          EXISTS (
            SELECT 1 FROM pg_attribute
            WHERE attrelid = 'app.ai_messages'::regclass
              AND attname = 'cited_chunk_ids' AND NOT attisdropped
          ) AS old_column_exists,
          c.relrowsecurity AS rls,
          c.relforcerowsecurity AS forced,
          (SELECT count(*)::text FROM pg_constraint
           WHERE conrelid = 'app.ai_message_citations'::regclass AND contype = 'f') AS foreign_keys
        FROM pg_class c WHERE c.oid = 'app.ai_message_citations'::regclass
      `;
      expect(shape).toEqual({
        old_column_exists: false,
        rls: true,
        forced: true,
        foreign_keys: "3",
      });

      await database.sql`DELETE FROM app.material_chunks WHERE id = ${chunkA1}`;
      const [afterChunkDelete] = await database.sql<{ orders: number[] }[]>`
        SELECT coalesce(array_agg(citation_order ORDER BY citation_order), '{}') AS orders
        FROM app.ai_message_citations WHERE ai_message_id = ${messageA}
      `;
      expect(afterChunkDelete!.orders).toEqual([5]);

      await database.sql`DELETE FROM app.ai_messages WHERE id = ${messageA}`;
      const [afterMessageDelete] = await database.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM app.ai_message_citations
      `;
      expect(afterMessageDelete!.count).toBe("0");
    } finally {
      await database.cleanup();
      await fixture.cleanup();
    }
  },
  120_000,
);
