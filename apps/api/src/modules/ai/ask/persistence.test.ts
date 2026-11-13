/**
 * Ask AI persistence tests (ST-296): stored-XSS neutralization for `app.ai_messages`.
 *
 * `persistAskMessage` is the only place a turn's question/answer reach the database — the route's
 * SSE stream never round-trips through storage before it reaches the client — so this proves the
 * sanitizer runs on the write path a later "conversation history" read depends on. Requires a live
 * PostgreSQL instance, gated on TEST_DATABASE_URL like every other integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/ai/ask/persistence.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createSchool,
  createStudent,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";

import { persistAskMessage, resolveConversation } from "./persistence";

import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

/** Run inside a tenant transaction, the same GUC + role setup the submission/evaluation suites use. */
async function asTenant<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    result = await fn(tx);
  });
  return result as T;
}

describeDb("persistAskMessage", () => {
  test("neutralizes stored-XSS probes in both the question and the answer", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);

    const messageId = await asTenant(school.id, async (tx) => {
      const conversationId = await resolveConversation(tx, {
        schoolId: school.id,
        studentId: student.id,
        conversationId: null,
        model: "test-model",
        locale: "en",
      });

      return persistAskMessage(tx, {
        schoolId: school.id,
        conversationId,
        question: "What happens when you type <script>alert(1)</script> into a form?",
        answer:
          "Good question! An <img src=x onerror=alert(document.cookie)> is a classic XSS probe.",
        citations: [],
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      });
    });

    const [row] = await asTenant(
      school.id,
      (tx) =>
        tx<{ question: string; answer: string }[]>`
        SELECT question, answer FROM app.ai_messages WHERE id = ${messageId}::uuid
      `,
    );

    expect(row).toBeDefined();
    expect(row!.question).not.toContain("<script>");
    expect(row!.question).not.toContain("</script>");
    expect(row!.question).toContain("What happens when you type");

    expect(row!.answer).not.toContain("<img");
    expect(row!.answer).not.toContain("onerror");
    expect(row!.answer).toContain("Good question!");
    expect(row!.answer).toContain("classic XSS probe.");
  });

  test("leaves an ordinary turn's text unchanged", async () => {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);

    const messageId = await asTenant(school.id, async (tx) => {
      const conversationId = await resolveConversation(tx, {
        schoolId: school.id,
        studentId: student.id,
        conversationId: null,
        model: "test-model",
        locale: "en",
      });

      return persistAskMessage(tx, {
        schoolId: school.id,
        conversationId,
        question: "How does photosynthesis work?",
        answer: "Plants convert light energy into chemical energy stored in glucose.",
        citations: [],
        promptTokens: 5,
        completionTokens: 12,
        totalTokens: 17,
      });
    });

    const [row] = await asTenant(
      school.id,
      (tx) =>
        tx<{ question: string; answer: string }[]>`
        SELECT question, answer FROM app.ai_messages WHERE id = ${messageId}::uuid
      `,
    );

    expect(row!.question).toBe("How does photosynthesis work?");
    expect(row!.answer).toBe("Plants convert light energy into chemical energy stored in glucose.");
  });
});
