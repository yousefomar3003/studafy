/**
 * Enforcing the safety filter at a route (ST-306): what happens after `moderateInput` /
 * `moderateOutput` says "blocked".
 *
 * Every block writes an `ai_moderation_decisions` row. A block in an escalating category (child
 * safety) additionally files an urgent `safety_filter` report into the moderation queue, with the
 * blocked text as its snapshot, and logs `ai_moderation_escalation` at error level so an alert
 * can page the on-call owner -- the text itself is never logged. The runbook
 * (docs/ai/content-moderation-runbook.md) is what a human does next.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { getLocalizedMessage } from "../../../middleware/locale";

import { moderateOutput, textHash, type AgeLevel, type ModerationResult } from "./moderate";
import {
  insertFilterEscalation,
  persistModerationDecision,
  type ModerationSurface,
} from "./persistence";
import { reportPriority, reportRespondBy, toReportSnapshot, type AiContentType } from "./reports";

import type { Database } from "../../../db/client";
import type { TenantContext } from "../../../db/tenant-tx";
import type { Logger } from "../../../logger";
import type { SupportedLocale } from "../../../middleware/locale";

export interface RecordBlockedContentInput {
  schoolId: string;
  studentId: string;
  surface: ModerationSurface;
  phase: "input" | "output";
  /** What the blocked text would have been, for the escalation report's `content_type`. */
  contentType: AiContentType;
  text: string;
  result: ModerationResult;
}

/**
 * Persist a block and, for an escalating category, its queue report -- in one tenant transaction,
 * so a decision is never recorded without its escalation.
 *
 * @returns the escalation report id, or null when the category does not escalate.
 */
export async function recordBlockedContent(
  database: Database,
  tenant: TenantContext,
  input: RecordBlockedContentInput,
  log?: Logger,
): Promise<string | null> {
  const reportId = await withTenantTx(database, tenant, async (tx) => {
    const decisionId = await persistModerationDecision(tx, {
      schoolId: input.schoolId,
      studentId: input.studentId,
      messageId: null,
      surface: input.surface,
      phase: input.phase,
      textHash: textHash(input.text),
      blocked: true,
      category: input.result.category ?? null,
    });
    if (!input.result.escalate) return null;

    const priority = reportPriority("child_safety");
    return insertFilterEscalation(tx, {
      schoolId: input.schoolId,
      studentId: input.studentId,
      contentType: input.contentType,
      moderationDecisionId: decisionId,
      contentSnapshot: toReportSnapshot(input.text),
      priority,
      respondBy: reportRespondBy(priority, new Date()),
    });
  });

  if (reportId) {
    log?.error(
      {
        event: "ai_moderation_escalation",
        report_id: reportId,
        school_id: input.schoolId,
        surface: input.surface,
        phase: input.phase,
        category: input.result.category,
      },
      "AI safety filter blocked content that requires human escalation",
    );
  }
  return reportId;
}

export interface AssertGeneratedContentSafeInput {
  schoolId: string;
  studentId: string;
  surface: Exclude<ModerationSurface, "ask">;
  contentType: AiContentType;
  /** Every student-visible string of the generation (prompts, options, answers, card faces...). */
  texts: readonly string[];
  locale: SupportedLocale;
  /** Moderation strictness. Non-Ask surfaces carry no age band yet, so this defaults to "high". */
  level?: AgeLevel;
}

/**
 * The generation-side filter for the non-streaming surfaces (quiz, flashcards, summary): call it
 * after the model answered and before anything is persisted, cached, or returned. A block throws
 * 422 AI_MODERATION_OUTPUT_BLOCKED; the entitlement gate then releases the quota hold, so a
 * blocked generation costs the student nothing -- the same posture the Ask route takes.
 */
export async function assertGeneratedContentSafe(
  database: Database,
  tenant: TenantContext,
  input: AssertGeneratedContentSafeInput,
  log?: Logger,
): Promise<void> {
  const text = input.texts.join("\n");
  const result = moderateOutput(text, input.level ?? "high");
  if (!result.blocked) return;

  await recordBlockedContent(
    database,
    tenant,
    {
      schoolId: input.schoolId,
      studentId: input.studentId,
      surface: input.surface,
      phase: "output",
      contentType: input.contentType,
      text,
      result,
    },
    log,
  );

  throw new CodedHttpException(
    422,
    ERROR_CODES.AI_MODERATION_OUTPUT_BLOCKED,
    result.guidance ?? getLocalizedMessage(ERROR_CODES.AI_MODERATION_OUTPUT_BLOCKED, input.locale),
  );
}
