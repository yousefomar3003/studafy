import postgres from "postgres";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { isFinalAttempt } from "../reports/report-runner";

import { isTransientAnthropicFailure } from "./anthropic-client";
import { examGenerationJobDataSchema } from "./job";
import { loadExamMaterials } from "./materials";
import { ExamGenerationInvalidError, parseExamGeneration } from "./parser";
import {
  claimExamSession,
  markExamSessionFailed,
  persistExamItemsAndMarkReady,
} from "./persistence";
import { assembleExamPrompt, toExamSources } from "./prompt";

import type { AnthropicClient } from "./anthropic-client";
import type { Job } from "bullmq";

export interface ExamGenerationWorkerConfig {
  databaseUrl: string;
  databaseCaCert?: string;
  /**
   * Absent when `ANTHROPIC_API_KEY` is not configured for the workers process -- the queue still
   * boots and jobs fail closed (session marked `failed`) at claim time, the same posture the
   * file-scan queue takes toward a missing `CLAMAV_HOST`.
   */
  anthropic: AnthropicClient | null;
}

type ExamGenerationResult =
  | { processed: false; reason: string }
  | { processed: true; examSessionId: string; generated: false }
  | { processed: true; examSessionId: string; generated: true; itemCount: number };

/**
 * Process one `generate-exam` job (ST-171).
 *
 * Lifecycle:
 *  1. Claim the `app.exam_sessions` row (`FOR UPDATE`, must still be `generating`) -- a duplicate or
 *     requeued job whose session already settled is an idempotent no-op.
 *  2. Load the requested materials' chunks. A material gone missing or un-ingested since the API's
 *     own (synchronous, at create time) check is a rare TOCTOU race, not a transient provider
 *     failure -- terminal immediately, no retry.
 *  3. Call the LLM. A transient failure (timeout, network, 5xx, 429) rethrows so BullMQ retries with
 *     its configured backoff, UNLESS this is already the last attempt, in which case the session is
 *     marked `failed` instead (`isFinalAttempt`, the exact idiom `reports/report-runner.ts` uses for
 *     the same "retry transient, fail permanent on the last attempt" shape). A non-transient failure
 *     (a 4xx verdict from a healthy provider) is terminal immediately, on the same terms
 *     `docs/rag/quiz-generation-and-grading.md` documents for its own synchronous path.
 *  4. Parse and validate the response (`parser.ts`, the same three-layer grounded validator quiz
 *     generation uses). A validation failure is terminal immediately -- retrying rarely helps, and
 *     there is deliberately no server-side repair retry, the same posture quiz's doc documents.
 *  5. Persist the item bank and flip the session to `ready`, atomically.
 */
export async function processExamGeneration(
  job: Job,
  config: ExamGenerationWorkerConfig,
): Promise<ExamGenerationResult> {
  const parsed = examGenerationJobDataSchema.safeParse(job.data);
  if (!parsed.success) return { processed: false, reason: "invalid job data" };
  const data = parsed.data;

  const sql = postgres(config.databaseUrl, {
    max: 2,
    idle_timeout: 20,
    prepare: false,
    ...(config.databaseCaCert
      ? { ssl: { ca: config.databaseCaCert, rejectUnauthorized: true } }
      : {}),
  });

  const fail = (reason: string) =>
    withSystemTenantTx(sql, { schoolId: data.schoolId }, (tx) =>
      markExamSessionFailed(tx, {
        examSessionId: data.examSessionId,
        schoolId: data.schoolId,
        reason,
      }),
    );

  try {
    const claimed = await withSystemTenantTx(sql, { schoolId: data.schoolId }, (tx) =>
      claimExamSession(tx, { examSessionId: data.examSessionId, schoolId: data.schoolId }),
    );
    if (!claimed) {
      return { processed: true, examSessionId: data.examSessionId, generated: false };
    }

    if (!config.anthropic) {
      await fail("exam generation is not configured (no AI provider credentials)");
      return { processed: true, examSessionId: data.examSessionId, generated: false };
    }

    const materialsResult = await withSystemTenantTx(sql, { schoolId: data.schoolId }, (tx) =>
      loadExamMaterials(tx, data.materialIds),
    );
    if (materialsResult.status !== "ok") {
      const reason =
        materialsResult.status === "not_found"
          ? `material ${materialsResult.materialId} does not exist`
          : `material ${materialsResult.materialId} is not yet ingested`;
      await fail(reason);
      return { processed: true, examSessionId: data.examSessionId, generated: false };
    }

    const sources = toExamSources(materialsResult.chunks);
    const prompt = assembleExamPrompt(sources, data.questionCount, data.questionTypes);

    let generation;
    try {
      generation = await config.anthropic.generate({
        model: data.model,
        system: prompt.system,
        prompt: prompt.user,
        maxTokens: data.maxTokens,
      });
    } catch (error) {
      if (
        isTransientAnthropicFailure(error) &&
        !isFinalAttempt(job.attemptsMade, job.opts.attempts)
      ) {
        throw error;
      }
      const reason =
        error instanceof Error
          ? `AI provider request failed: ${error.message}`
          : "AI provider request failed";
      await fail(reason);
      return { processed: true, examSessionId: data.examSessionId, generated: false };
    }

    let items;
    try {
      items = parseExamGeneration(generation.content, sources.length);
    } catch (error) {
      const reason =
        error instanceof ExamGenerationInvalidError
          ? error.message
          : "exam generation response failed validation";
      await fail(reason);
      return { processed: true, examSessionId: data.examSessionId, generated: false };
    }

    await withSystemTenantTx(sql, { schoolId: data.schoolId }, (tx) =>
      persistExamItemsAndMarkReady(tx, {
        examSessionId: data.examSessionId,
        schoolId: data.schoolId,
        items,
        sources,
        usage: generation.usage,
      }),
    );

    return {
      processed: true,
      examSessionId: data.examSessionId,
      generated: true,
      itemCount: items.length,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
