import { z } from "zod";

/**
 * The contract for a `generate-exam` job (ST-171).
 *
 * The API resolves the model/tier (`resolveAiModel("exam", ...)`) and the output-token ceiling
 * (the same `questionCount`-scaled math `AI_QUIZ_OUTPUT_TOKENS_CEILING` uses) and validates the
 * request's scope bounds before enqueueing, so the worker never duplicates routing, reservation, or
 * validation logic — it carries out generation exactly as instructed. `examSessionId` is what the
 * worker claims by (its `app.exam_sessions` row already exists, created with
 * `status = 'generating'` in the same transaction that created this payload), the same shape the
 * `ai-ingestion` job's `materialId` claim uses.
 */
export const examGenerationJobDataSchema = z.object({
  version: z.literal(1),
  examSessionId: z.string().uuid(),
  schoolId: z.string().uuid(),
  studentId: z.string().uuid(),
  materialIds: z.array(z.string().uuid()).min(1),
  questionCount: z.number().int().min(1),
  questionTypes: z.array(z.enum(["mcq", "short_answer"])).min(1),
  model: z.string().min(1),
  tier: z.enum(["small", "large"]),
  maxTokens: z.number().int().min(1),
});

export type ExamGenerationJobData = z.infer<typeof examGenerationJobDataSchema>;
