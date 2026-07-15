// AI tutoring data: per-student AI entitlements, a conversation and message each, normalized citations
// back to real material chunks, and usage meters. ai_messages are append-only (no updated_at) and carry
// a 90-day retention marker (expires_at). Citations live in the ai_message_citations junction table
// (cited_chunk_ids was normalized away in migration 000023).
import { seedDate, uuid } from "../support";

import type { FullCtx, MaterialsCtx, Sql } from "../support";

const MODEL = "claude-sonnet-5";

export async function seedAi(sql: Sql, ctx: FullCtx, materials: MaterialsCtx): Promise<void> {
  const { schoolId, students } = ctx;
  const aiStudents = students.slice(0, 4);
  const citableChunks = materials.chunkIds.slice(0, 2);

  const subscriptionIdByStudent = new Map(aiStudents.map((student) => [student.studentId, uuid()]));
  await sql`
    INSERT INTO app.ai_subscriptions ${sql(
      aiStudents.map((student) => ({
        id: subscriptionIdByStudent.get(student.studentId)!,
        school_id: schoolId,
        student_id: student.studentId,
        status: "active",
        current_period_start: seedDate(-15),
        current_period_end: seedDate(45),
      })),
      "id",
      "school_id",
      "student_id",
      "status",
      "current_period_start",
      "current_period_end",
    )}
  `;

  const conversationIdByStudent = new Map(aiStudents.map((student) => [student.studentId, uuid()]));
  await sql`
    INSERT INTO app.ai_conversations ${sql(
      aiStudents.map((student) => ({
        id: conversationIdByStudent.get(student.studentId)!,
        school_id: schoolId,
        student_id: student.studentId,
        model: MODEL,
      })),
      "id",
      "school_id",
      "student_id",
      "model",
    )}
  `;

  const messageIdByStudent = new Map(aiStudents.map((student) => [student.studentId, uuid()]));
  await sql`
    INSERT INTO app.ai_messages ${sql(
      aiStudents.map((student) => {
        const promptTokens = 180;
        const completionTokens = 220;
        return {
          id: messageIdByStudent.get(student.studentId)!,
          school_id: schoolId,
          conversation_id: conversationIdByStudent.get(student.studentId)!,
          question: "Can you explain how photosynthesis works?",
          answer:
            "Photosynthesis converts light energy into glucose. The light reactions in the thylakoid " +
            "membranes produce ATP and NADPH, which the Calvin cycle uses to fix carbon dioxide.",
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          expires_at: seedDate(120),
        };
      }),
      "id",
      "school_id",
      "conversation_id",
      "question",
      "answer",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "expires_at",
    )}
  `;

  // Cite the first couple of chunks from each student's answer.
  if (citableChunks.length > 0) {
    const citationRows = aiStudents.flatMap((student) =>
      citableChunks.map((chunkId, index) => ({
        school_id: schoolId,
        ai_message_id: messageIdByStudent.get(student.studentId)!,
        material_chunk_id: chunkId,
        citation_order: index + 1,
      })),
    );
    await sql`
      INSERT INTO app.ai_message_citations ${sql(
        citationRows,
        "school_id",
        "ai_message_id",
        "material_chunk_id",
        "citation_order",
      )}
    `;
  }

  await sql`
    INSERT INTO app.ai_usage_meters ${sql(
      aiStudents.map((student) => ({
        id: uuid(),
        school_id: schoolId,
        student_id: student.studentId,
        ai_subscription_id: subscriptionIdByStudent.get(student.studentId)!,
        total_tokens: 400,
      })),
      "id",
      "school_id",
      "student_id",
      "ai_subscription_id",
      "total_tokens",
    )}
  `;
}
