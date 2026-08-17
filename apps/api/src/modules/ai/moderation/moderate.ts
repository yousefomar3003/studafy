/**
 * Content moderation for AI surfaces — input and output gating.
 *
 * Every student question (input) and every model generation (output) passes through
 * {@link moderateInput} or {@link moderateOutput} before it is persisted or streamed. The
 * moderation is a pure, synchronous, pattern-based check: no external API call, no model call, no
 * network hop. A blocking match returns the first category that triggered, with the age-appropriate
 * guidance the client shows instead of the blocked content.
 *
 * The provider interface (`ModerationProvider`) exists so a deployment can swap the pattern-based
 * default for an external moderation API (e.g., Anthropic content policy, a third-party service)
 * without changing any call site. The default `PatternModerationProvider` is the only concrete
 * implementation shipped here.
 *
 * All moderation decisions (blocked and allowed) are logged to `app.ai_moderation_decisions` via
 * the persistence layer — see `moderation/persistence.ts`.
 */

import { createHash } from "crypto";

import {
  type AgeLevel,
  levelBlocked,
  MODERATION_CATEGORIES,
  type ModerationCategory,
} from "./policy";

export type { AgeLevel } from "./policy";

/**
 * The result of a moderation check. When `blocked` is false, the content passed all categories.
 * When true, `category` identifies which category triggered and `guidance` is the age-appropriate
 * message the client should display.
 */
export interface ModerationResult {
  blocked: boolean;
  category?: string;
  guidance?: string;
}

/**
 * Input-specific moderation: checks the student's question before it reaches the LLM.
 *
 * @returns {@link ModerationResult} — `blocked: true` means the question must not be sent to the
 *   model; `blocked: false` means it passed all categories.
 */
export function moderateInput(text: string, level: AgeLevel = "high"): ModerationResult {
  return checkText(text, level);
}

/**
 * Output-specific moderation: checks the model's generation before it reaches the student.
 *
 * @returns {@link ModerationResult} — `blocked: true` means the answer must not be streamed or
 *   persisted; `blocked: false` means it passed all categories.
 */
export function moderateOutput(text: string, level: AgeLevel = "high"): ModerationResult {
  return checkText(text, level);
}

/**
 * Compute a deterministic sha-256 hex digest of the checked text. Used as the `text_hash` column
 * in `ai_moderation_decisions` — avoids storing full text in the audit table while still allowing
 * dedup and lookup by hash.
 */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The provider interface. Implementations perform content moderation and return a result.
 * The default implementation is {@link PatternModerationProvider}.
 */
export interface ModerationProvider {
  check(text: string, level: AgeLevel, phase: "input" | "output"): ModerationResult;
}

/**
 * Pattern-based moderation provider. Synchronous, zero-cost, fully deterministic.
 *
 * Iterates the moderation categories in severity order (self_harm → hate_speech → sexual_content
 * → violence → profanity → pii_sharing) and returns the first match that blocks at the student's
 * age level. If no category blocks, the content is allowed.
 */
export class PatternModerationProvider implements ModerationProvider {
  check(text: string, level: AgeLevel, _phase: "input" | "output"): ModerationResult {
    return checkText(text, level);
  }
}

function checkText(text: string, level: AgeLevel): ModerationResult {
  for (const category of MODERATION_CATEGORIES) {
    if (!levelBlocked(level, category.blockThreshold)) continue;
    if (matchesAny(text, category)) {
      return {
        blocked: true,
        category: category.key,
        guidance: category.guidance[level],
      };
    }
  }
  return { blocked: false };
}

function matchesAny(text: string, category: ModerationCategory): boolean {
  for (const pattern of category.patterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}
