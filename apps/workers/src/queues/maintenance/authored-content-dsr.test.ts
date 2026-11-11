/**
 * Erasure of what a person wrote themselves (authored-content-dsr.ts), driven through
 * runTenantErasure the way the DSR processor runs it: a parent's sent messages, a student's AI study
 * content, and a school's closure. Requires a live, migrated PostgreSQL instance, gated on
 * TEST_DATABASE_URL. The tests share one school and run in order.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";

import { AUTHORED_CONTENT_TABLES } from "./retention-registry";
import { resolveSubjectIdentifiers } from "./subject-resolver";
import { runTenantErasure } from "./tenant-erasure.worker";

import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const describeDb = enabled ? describe : describe.skip;

let sql: Sql | undefined;

const MARKER = "[deleted]";

interface Fixture {
  schoolId: string;
  parentUserId: string;
  teacherUserId: string;
  studentUserId: string;
  studentId: string;
  otherStudentId: string;
  messages: {
    parentPlain: string;
    parentReported: string;
    parentInClosedReport: string;
    teacherReply: string;
  };
  keys: {
    parentPlain: string;
    parentReported: string;
    parentInClosedReport: string;
    teacherReply: string;
  };
  notifications: { toTeacher: string; toParent: string };
  ai: {
    conversationId: string;
    messageId: string;
    decisionId: string;
    quizId: string;
    deckId: string;
    examId: string;
    otherConversationId: string;
    otherQuizId: string;
  };
  submissionId: string;
}

let fx: Fixture;

function asAdmin<T>(schoolId: string | undefined, fn: (tx: TransactionSql) => Promise<T>) {
  return sql!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function insertId(query: Promise<{ id: string }[]>): Promise<string> {
  const [row] = await query;
  return row!.id;
}

async function seed(): Promise<Fixture> {
  const [country] = await sql!<{ id: string }[]>`SELECT id FROM app.countries LIMIT 1`;
  const [currency] = await sql!<{ id: string }[]>`SELECT id FROM app.currencies LIMIT 1`;
  const slug = "authored-" + crypto.randomUUID().slice(0, 8);
  const schoolId = await asAdmin(undefined, (tx) =>
    insertId(tx`
      INSERT INTO app.schools (slug, name, status, country_id, default_currency_id, email, normalized_email)
      VALUES (${slug}, 'Authored Content Fixture', 'active', ${country!.id}, ${currency!.id},
              ${slug + "@example.com"}, ${slug + "@example.com"})
      RETURNING id
    `),
  );

  return asAdmin(schoolId, async (tx) => {
    const user = (name: string) =>
      insertId(tx`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${`${name}-${slug}@example.com`}, ${`${name}-${slug}@example.com`},
                ${name}, 'active')
        RETURNING id
      `);
    const adminId = await user("admin");
    await tx`INSERT INTO app.user_roles (school_id, user_id, role) VALUES (${schoolId}::uuid, ${adminId}::uuid, 'ORG_ADMIN')`;
    const parentUserId = await user("parent");
    const teacherUserId = await user("teacher");
    const studentUserId = await user("student");
    const otherStudentUserId = await user("other-student");

    const student = (userId: string, admission: string, first: string) =>
      insertId(tx`
        INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
        VALUES (${schoolId}::uuid, ${userId}::uuid, ${admission}, ${first}, 'Fixture', 'enrolled')
        RETURNING id
      `);
    const studentId = await student(studentUserId, "ADM-1", "Erase");
    const otherStudentId = await student(otherStudentUserId, "ADM-2", "Keep");
    const teacherId = await insertId(tx`
      INSERT INTO app.teachers (school_id, user_id, employee_number)
      VALUES (${schoolId}::uuid, ${teacherUserId}::uuid, 'EMP-1') RETURNING id
    `);

    // -------------------------------------------------------------------------------------------
    // Messaging: one thread about the student, between the parent and the teacher.
    // -------------------------------------------------------------------------------------------
    const conversationId = await insertId(tx`
      INSERT INTO app.message_conversations (school_id, parent_user_id, teacher_user_id, student_id)
      VALUES (${schoolId}::uuid, ${parentUserId}::uuid, ${teacherUserId}::uuid, ${studentId}::uuid)
      RETURNING id
    `);
    const message = (sender: string, body: string) =>
      insertId(tx`
        INSERT INTO app.messages (school_id, conversation_id, sender_user_id, body)
        VALUES (${schoolId}::uuid, ${conversationId}::uuid, ${sender}::uuid, ${body})
        RETURNING id
      `);
    const image = async (messageId: string) => {
      const key = `permanent/${schoolId}/message-attachments/${crypto.randomUUID()}.jpg`;
      const id = await insertId(tx`
        INSERT INTO app.message_attachments
          (school_id, message_id, position, storage_key, original_file_name, mime_type, size_bytes)
        VALUES (${schoolId}::uuid, ${messageId}::uuid, 0, ${key}, 'photo.jpg', 'image/jpeg', 100)
        RETURNING id
      `);
      return { id, key };
    };
    const messages = {
      parentPlain: await message(parentUserId, "Hello from the parent"),
      teacherReply: await message(teacherUserId, "Reply from the teacher"),
      parentReported: await message(parentUserId, "A message under an open report"),
      parentInClosedReport: await message(parentUserId, "A message a closed report copied"),
    };
    const images = {
      parentPlain: await image(messages.parentPlain),
      teacherReply: await image(messages.teacherReply),
      parentReported: await image(messages.parentReported),
      parentInClosedReport: await image(messages.parentInClosedReport),
    };

    // An open report by the teacher pointing at one of the parent's messages.
    await tx`
      INSERT INTO app.message_reports (school_id, conversation_id, student_id, message_id,
        reporter_user_id, reporter_role, reported_user_id, reason_category, priority, respond_by)
      VALUES (${schoolId}::uuid, ${conversationId}::uuid, ${studentId}::uuid,
              ${messages.parentReported}::uuid, ${teacherUserId}::uuid, 'teacher',
              ${parentUserId}::uuid, 'harassment', 'high', now() + interval '1 day')
    `;
    // A dismissed report whose snapshot copied another message and references its image.
    const closedReportId = await insertId(tx`
      INSERT INTO app.message_reports (school_id, conversation_id, student_id, message_id,
        reporter_user_id, reporter_role, reported_user_id, reason_category, priority, respond_by,
        status, resolution_note, reviewed_by, reviewed_at)
      VALUES (${schoolId}::uuid, ${conversationId}::uuid, ${studentId}::uuid,
              ${messages.parentInClosedReport}::uuid, ${teacherUserId}::uuid, 'teacher',
              ${parentUserId}::uuid, 'spam', 'normal', now() + interval '1 day',
              'dismissed', 'Not spam', ${adminId}::uuid, now())
      RETURNING id
    `);
    const snapshotId = await insertId(tx`
      INSERT INTO app.message_report_messages (school_id, report_id, message_id, position,
        sender_user_id, sender_name, body, message_created_at, is_reported)
      VALUES (${schoolId}::uuid, ${closedReportId}::uuid, ${messages.parentInClosedReport}::uuid, 0,
              ${parentUserId}::uuid, 'parent', 'A message a closed report copied', now(), true)
      RETURNING id
    `);
    await tx`
      INSERT INTO app.message_report_attachments (school_id, report_message_id, attachment_id)
      VALUES (${schoolId}::uuid, ${snapshotId}::uuid, ${images.parentInClosedReport.id}::uuid)
    `;

    const notification = (userId: string, preview: string) =>
      insertId(tx`
        INSERT INTO app.notifications (school_id, user_id, notification_type, title, body, metadata)
        VALUES (${schoolId}::uuid, ${userId}::uuid, 'DIRECT_MESSAGE'::app.notification_type,
                'New message', ${preview}, ${tx.json({ conversation_id: conversationId })})
        RETURNING id
      `);
    const notifications = {
      toTeacher: await notification(teacherUserId, "Hello from the parent"),
      toParent: await notification(parentUserId, "Reply from the teacher"),
    };

    // -------------------------------------------------------------------------------------------
    // Academic structure: a class with one ingested material, the AI content's grounding.
    // -------------------------------------------------------------------------------------------
    const yearId = await insertId(tx`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on)
      VALUES (${schoolId}::uuid, 'AY', 'Year', '2026-09-01', '2027-06-30') RETURNING id
    `);
    const termId = await insertId(tx`
      INSERT INTO app.terms (school_id, academic_year_id, code, name, starts_on, ends_on, sequence_number)
      VALUES (${schoolId}::uuid, ${yearId}::uuid, 'T1', 'Term', '2026-09-01', '2026-12-31', 1)
      RETURNING id
    `);
    const subjectId = await insertId(tx`
      INSERT INTO app.subjects (school_id, code, name) VALUES (${schoolId}::uuid, 'MATH', 'Maths')
      RETURNING id
    `);
    const courseId = await insertId(tx`
      INSERT INTO app.courses (school_id, subject_id, code, name)
      VALUES (${schoolId}::uuid, ${subjectId}::uuid, 'MATH10', 'Maths 10') RETURNING id
    `);
    const classId = await insertId(tx`
      INSERT INTO app.classes (school_id, course_id, academic_year_id, term_id, lead_teacher_id, code)
      VALUES (${schoolId}::uuid, ${courseId}::uuid, ${yearId}::uuid, ${termId}::uuid,
              ${teacherId}::uuid, 'CLS-1')
      RETURNING id
    `);
    const materialId = await insertId(tx`
      INSERT INTO app.materials (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id,
        title, storage_key, original_file_name, mime_type, size_bytes)
      VALUES (${schoolId}::uuid, ${classId}::uuid, ${teacherUserId}::uuid, ${teacherUserId}::uuid,
              'Fractions', ${`permanent/${schoolId}/materials/fractions.pdf`}, 'fractions.pdf',
              'application/pdf', 100)
      RETURNING id
    `);
    const chunkId = await insertId(tx`
      INSERT INTO app.material_chunks (school_id, material_id, chunk_index, content, embedding, embedding_model)
      VALUES (${schoolId}::uuid, ${materialId}::uuid, 0, 'A fraction is a part of a whole.',
              array_fill(0::real, ARRAY[1536])::public.vector, 'test')
      RETURNING id
    `);

    // Work the student handed in: the school's record, never erased as authored content.
    const assignmentId = await insertId(tx`
      INSERT INTO app.assignments (school_id, class_id, created_by_user_id, last_edited_by_user_id,
        title, due_at, max_score)
      VALUES (${schoolId}::uuid, ${classId}::uuid, ${teacherUserId}::uuid, ${teacherUserId}::uuid,
              'Fractions essay', now() + interval '7 days', 10)
      RETURNING id
    `);
    const submissionId = await insertId(tx`
      INSERT INTO app.assignment_submissions (school_id, assignment_id, student_id,
        last_edited_by_user_id, content)
      VALUES (${schoolId}::uuid, ${assignmentId}::uuid, ${studentId}::uuid, ${studentUserId}::uuid,
              'My essay about fractions')
      RETURNING id
    `);

    // -------------------------------------------------------------------------------------------
    // AI study content, for the student and for another student.
    // -------------------------------------------------------------------------------------------
    const askTurn = async (owner: string) => {
      const conversation = await insertId(tx`
        INSERT INTO app.ai_conversations (school_id, student_id, model)
        VALUES (${schoolId}::uuid, ${owner}::uuid, 'test-model') RETURNING id
      `);
      const turn = await insertId(tx`
        INSERT INTO app.ai_messages (school_id, conversation_id, question, answer, prompt_tokens,
          completion_tokens, total_tokens, expires_at)
        VALUES (${schoolId}::uuid, ${conversation}::uuid, 'What is a fraction?', 'A part of a whole.',
                10, 5, 15, now() + interval '90 days')
        RETURNING id
      `);
      await tx`
        INSERT INTO app.ai_message_citations (school_id, ai_message_id, material_chunk_id, citation_order)
        VALUES (${schoolId}::uuid, ${turn}::uuid, ${chunkId}::uuid, 1)
      `;
      return { conversation, turn };
    };
    const quiz = async (owner: string) => {
      const quizId = await insertId(tx`
        INSERT INTO app.quizzes (school_id, student_id, model, question_count)
        VALUES (${schoolId}::uuid, ${owner}::uuid, 'test-model', 1) RETURNING id
      `);
      const questionId = await insertId(tx`
        INSERT INTO app.quiz_questions (school_id, quiz_id, question_order, question_type, prompt,
          correct_option_id, material_chunk_id)
        VALUES (${schoolId}::uuid, ${quizId}::uuid, 1, 'mcq', 'Which is a fraction?', 'a',
                ${chunkId}::uuid)
        RETURNING id
      `);
      await tx`
        INSERT INTO app.quiz_question_options (school_id, quiz_question_id, option_order, option_key, option_text)
        VALUES (${schoolId}::uuid, ${questionId}::uuid, 1, 'a', 'One half')
      `;
      return quizId;
    };

    const mine = await askTurn(studentId);
    const theirs = await askTurn(otherStudentId);
    const decisionId = await insertId(tx`
      INSERT INTO app.ai_moderation_decisions (school_id, student_id, message_id, phase, text_hash, blocked)
      VALUES (${schoolId}::uuid, ${studentId}::uuid, ${mine.turn}::uuid, 'input', 'hash', false)
      RETURNING id
    `);
    await tx`
      INSERT INTO app.ai_content_reports (school_id, student_id, content_type, content_id,
        content_snapshot, source, reporter_id, reason_category, priority, respond_by)
      VALUES (${schoolId}::uuid, ${studentId}::uuid, 'ask_answer', ${mine.turn}::uuid,
              'A part of a whole.', 'user_report', ${studentUserId}::uuid, 'inaccurate', 'normal',
              now() + interval '1 day')
    `;
    const quizId = await quiz(studentId);
    const otherQuizId = await quiz(otherStudentId);

    const deckId = await insertId(tx`
      INSERT INTO app.flashcard_decks (school_id, student_id, model, card_count)
      VALUES (${schoolId}::uuid, ${studentId}::uuid, 'test-model', 1) RETURNING id
    `);
    const cardId = await insertId(tx`
      INSERT INTO app.flashcards (school_id, deck_id, card_order, card_type, front, back, material_chunk_id)
      VALUES (${schoolId}::uuid, ${deckId}::uuid, 1, 'q_a', 'Half of 4?', '2', ${chunkId}::uuid)
      RETURNING id
    `);
    await tx`
      INSERT INTO app.flashcard_reviews (school_id, student_id, card_id, interval_days, ease_factor,
        repetitions, due_at, review_count)
      VALUES (${schoolId}::uuid, ${studentId}::uuid, ${cardId}::uuid, 1, 2.5, 1, now(), 1)
    `;

    const examId = await insertId(tx`
      INSERT INTO app.exam_sessions (school_id, student_id, model, tier, question_count,
        duration_minutes, status, input_tokens, output_tokens)
      VALUES (${schoolId}::uuid, ${studentId}::uuid, 'test-model', 'small', 1, 10, 'ready', 10, 10)
      RETURNING id
    `);
    const itemId = await insertId(tx`
      INSERT INTO app.exam_items (school_id, exam_session_id, item_order, item_type, prompt,
        correct_answer, material_chunk_id)
      VALUES (${schoolId}::uuid, ${examId}::uuid, 1, 'short_answer', 'Half of 6?', '3', ${chunkId}::uuid)
      RETURNING id
    `);
    await tx`
      INSERT INTO app.exam_item_answers (school_id, exam_item_id, submitted_answer, is_correct)
      VALUES (${schoolId}::uuid, ${itemId}::uuid, '3', true)
    `;

    return {
      schoolId,
      parentUserId,
      teacherUserId,
      studentUserId,
      studentId,
      otherStudentId,
      messages,
      keys: {
        parentPlain: images.parentPlain.key,
        parentReported: images.parentReported.key,
        parentInClosedReport: images.parentInClosedReport.key,
        teacherReply: images.teacherReply.key,
      },
      notifications,
      ai: {
        conversationId: mine.conversation,
        messageId: mine.turn,
        decisionId,
        quizId,
        deckId,
        examId,
        otherConversationId: theirs.conversation,
        otherQuizId,
      },
      submissionId,
    };
  });
}

/** Runs the erasure as the DSR processor does: a system tenant transaction. */
function erase(subjectUserId?: string) {
  return withSystemTenantTx(sql!, { schoolId: fx.schoolId }, async (tx) => {
    const subject = subjectUserId
      ? await resolveSubjectIdentifiers(tx, fx.schoolId, subjectUserId)
      : undefined;
    return runTenantErasure(tx, fx.schoolId, subject);
  });
}

async function bodies(): Promise<Record<string, string>> {
  const rows = await asAdmin(
    fx.schoolId,
    (tx) => tx<{ id: string; body: string }[]>`
      SELECT id, body FROM app.messages WHERE school_id = ${fx.schoolId}::uuid
    `,
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.body]));
}

async function attachmentKeys(): Promise<string[]> {
  const rows = await asAdmin(
    fx.schoolId,
    (tx) => tx<{ storage_key: string }[]>`
      SELECT storage_key FROM app.message_attachments WHERE school_id = ${fx.schoolId}::uuid
    `,
  );
  return rows.map((row) => row.storage_key).sort();
}

async function count(table: string, where = "true"): Promise<number> {
  const [row] = await asAdmin(fx.schoolId, (tx) =>
    tx.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM app."${table}" WHERE school_id = $1 AND ${where}`,
      [fx.schoolId],
    ),
  );
  return row!.n;
}

beforeAll(async () => {
  if (!enabled) return;
  sql = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
  fx = await seed();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describeDb("erasing what a person wrote", () => {
  test("every AUTHORED_CONTENT_TABLES entry is a real tenant table", async () => {
    const rows = await sql!<{ table_name: string }[]>`
      SELECT c.table_name FROM information_schema.columns AS c
      WHERE c.table_schema = 'app' AND c.column_name = 'school_id'
        AND c.table_name = ANY(${[...AUTHORED_CONTENT_TABLES.keys()]}::text[])
    `;
    expect(rows.map((row) => row.table_name).sort()).toEqual(
      [...AUTHORED_CONTENT_TABLES.keys()].sort(),
    );
  });

  test("a parent's sent messages are blanked, except those an open report holds", async () => {
    const result = await erase(fx.parentUserId);

    const after = await bodies();
    expect(after[fx.messages.parentPlain]).toBe(MARKER);
    expect(after[fx.messages.parentInClosedReport]).toBe(MARKER);
    // Safeguarding: an open report still points at this one.
    expect(after[fx.messages.parentReported]).toBe("A message under an open report");
    // The other participant's side of the thread is untouched.
    expect(after[fx.messages.teacherReply]).toBe("Reply from the teacher");

    // The plain message's image is gone and handed back for deletion after commit; the reported
    // message keeps its image, and so does the one a closed report's snapshot references.
    expect(result.orphanedStorageKeys).toEqual([fx.keys.parentPlain]);
    expect(await attachmentKeys()).toEqual(
      [fx.keys.parentInClosedReport, fx.keys.parentReported, fx.keys.teacherReply].sort(),
    );

    // The teacher's notification quoted the parent's message; the parent's own inbox is not theirs
    // to erase.
    const notes = await asAdmin(
      fx.schoolId,
      (tx) => tx<{ id: string; body: string }[]>`
        SELECT id, body FROM app.notifications WHERE school_id = ${fx.schoolId}::uuid
      `,
    );
    const noteBody = Object.fromEntries(notes.map((row) => [row.id, row.body]));
    expect(noteBody[fx.notifications.toTeacher]).toBe(MARKER);
    expect(noteBody[fx.notifications.toParent]).toBe("Reply from the teacher");

    // The report snapshots are the school's safeguarding record.
    expect(
      await count("message_report_messages", "body = 'A message a closed report copied'"),
    ).toBe(1);

    expect(result.redactedTables).toContainEqual({
      table: "messages",
      action: "redacted",
      columns: ["body"],
      rows: 2,
    });
    expect(result.redactedTables).toContainEqual({
      table: "message_attachments",
      action: "hard_deleted",
      columns: [],
      rows: 1,
    });
    const retained = Object.fromEntries(
      result.retainedTables.map((entry) => [entry.table, entry.reason]),
    );
    expect(retained.messages).toStartWith("1 ");
    expect(retained.message_attachments).toStartWith("1 ");
    expect(retained.message_report_messages).toBeDefined();

    // A parent has no AI study content: nothing of the student's is touched by the parent's erasure.
    expect(await count("ai_conversations")).toBe(2);
  });

  test("erasing again changes nothing more", async () => {
    const result = await erase(fx.parentUserId);
    expect(result.redactedTables.find((entry) => entry.table === "messages")).toBeUndefined();
    expect(result.orphanedStorageKeys).toEqual([]);
  });

  test("a student's AI study content is deleted; others' content and school records stay", async () => {
    const result = await erase(fx.studentUserId);

    const studentOwned = `student_id = '${fx.studentId}'`;
    expect(await count("ai_conversations", studentOwned)).toBe(0);
    expect(await count("ai_messages", `id = '${fx.ai.messageId}'`)).toBe(0);
    expect(await count("quizzes", studentOwned)).toBe(0);
    expect(await count("flashcard_decks", studentOwned)).toBe(0);
    expect(await count("flashcard_reviews", studentOwned)).toBe(0);
    expect(await count("exam_sessions", studentOwned)).toBe(0);
    expect(await count("exam_items")).toBe(0);
    expect(await count("exam_item_answers")).toBe(0);

    // The other student's conversation, its turn and citation, and their quiz remain.
    expect(await count("ai_conversations", `id = '${fx.ai.otherConversationId}'`)).toBe(1);
    expect(await count("ai_messages")).toBe(1);
    expect(await count("ai_message_citations")).toBe(1);
    expect(await count("quizzes", `id = '${fx.ai.otherQuizId}'`)).toBe(1);
    expect(await count("quiz_questions")).toBe(1);
    expect(await count("quiz_question_options")).toBe(1);

    // The safety filter's decision stays (a hash, not the text), detached from the deleted turn; the
    // content report keeps its own snapshot.
    expect(
      await count("ai_moderation_decisions", `id = '${fx.ai.decisionId}' AND message_id IS NULL`),
    ).toBe(1);
    expect(await count("ai_content_reports", studentOwned)).toBe(1);
    expect(result.retainedTables.map((entry) => entry.table)).toContain("ai_content_reports");

    // Work handed in stays in the school's records, text and all.
    expect(
      await count(
        "assignment_submissions",
        `id = '${fx.submissionId}' AND content = 'My essay about fractions'`,
      ),
    ).toBe(1);
    expect(result.retainedTables.map((entry) => entry.table)).toContain("subscriptions");

    for (const table of [
      "ai_conversations",
      "ai_messages",
      "ai_message_citations",
      "quizzes",
      "quiz_questions",
      "quiz_question_options",
      "flashcard_decks",
      "flashcards",
      "flashcard_reviews",
      "exam_sessions",
      "exam_items",
      "exam_item_answers",
    ]) {
      expect(result.redactedTables).toContainEqual({
        table,
        action: "hard_deleted",
        columns: [],
        rows: 1,
      });
    }
  });

  test("a school's closure applies the same rules to everyone", async () => {
    const result = await erase();

    const after = await bodies();
    expect(after[fx.messages.teacherReply]).toBe(MARKER);
    expect(after[fx.messages.parentReported]).toBe("A message under an open report");

    expect(result.orphanedStorageKeys).toEqual([fx.keys.teacherReply]);
    expect(await attachmentKeys()).toEqual(
      [fx.keys.parentInClosedReport, fx.keys.parentReported].sort(),
    );
    // What the authored-content pass kept still has its file names redacted by the walk, as before.
    expect(await count("message_attachments", "original_file_name LIKE 'erased-%'")).toBe(2);

    expect(await count("notifications", `body <> '${MARKER}'`)).toBe(0);
    expect(await count("ai_conversations")).toBe(0);
    expect(await count("ai_messages")).toBe(0);
    expect(await count("quizzes")).toBe(0);
    expect(await count("ai_content_reports")).toBe(1);
    expect(await count("assignment_submissions", `id = '${fx.submissionId}'`)).toBe(1);
  });
});
