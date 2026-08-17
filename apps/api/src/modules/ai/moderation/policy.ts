/**
 * Content moderation policy for AI surfaces.
 *
 * Defines the six content categories the pattern-based moderator checks, the regex patterns that
 * detect each category, the per-age-level severity thresholds that decide whether a match blocks,
 * and the guidance messages shown to students when their content is blocked.
 *
 * The patterns are deliberately conservative: a K-12 study assistant must not block legitimate
 * academic questions ("how does the immune system kill bacteria?") but must catch genuine policy
 * violations. The age-level thresholds tighten from high → middle → elementary so younger students
 * get stricter filtering.
 */

import { AI_EXPLAIN_LEVELS } from "../config";

export type AgeLevel = (typeof AI_EXPLAIN_LEVELS)[number];

/**
 * The six moderation categories. Each maps to a set of word-boundary-anchored regex patterns and
 * an age-level severity threshold (the minimum level at which a match blocks).
 *
 * Severity ordering for thresholds: elementary < middle < high. A threshold of `"high"` means
 * the pattern blocks at every level; `"middle"` blocks at middle and elementary; `"elementary"`
 * blocks only at elementary.
 */
export interface ModerationCategory {
  /** Machine-readable key, stored in ai_moderation_decisions.category. */
  key: string;
  /** Human-readable label for logs. */
  label: string;
  /** Word-boundary-anchored patterns to match against. */
  patterns: RegExp[];
  /**
   * The strictest age level that this pattern blocks at. A match blocks if the student's level
   * is at or below this threshold. `"elementary"` = blocks only for the youngest;
   * `"high"` = blocks for everyone.
   */
  blockThreshold: AgeLevel;
  /** Age-appropriate guidance shown to the student on block. Keyed by age level. */
  guidance: Record<AgeLevel, string>;
}

const LEVEL_RANK: Record<AgeLevel, number> = { elementary: 0, middle: 1, high: 2 };

function levelBlocked(studentLevel: AgeLevel, threshold: AgeLevel): boolean {
  return LEVEL_RANK[studentLevel] <= LEVEL_RANK[threshold];
}

/**
 * Moderation categories with detection patterns and per-level guidance.
 *
 * Patterns use `\b` word boundaries to avoid matching substrings (e.g. "class" should not match
 * "ass"). All patterns are case-insensitive. The categories are ordered by typical severity so
 * the first blocking match found is the one returned.
 */
export const MODERATION_CATEGORIES: readonly ModerationCategory[] = [
  {
    key: "self_harm",
    label: "Self-harm",
    patterns: [
      /\b(?:kill\s+(?:my)?self|suicide|suicidal|want\s+to\s+die|end\s+my\s+life|self[- ]?harm|cutting\s+myself)\b/i,
      /\b(?:how\s+to\s+(?:kill|die|commit\s+suicide))\b/i,
      /\b(?:i['']?m\s+(?:going|gonna)\s+to\s+(?:hurt|kill)\s+(?:my)?self)\b/i,
    ],
    blockThreshold: "high",
    guidance: {
      elementary:
        "If you're feeling upset or hurt, please talk to a trusted adult or your school counselor. You are not alone.",
      middle:
        "If you're struggling, please reach out to a trusted adult or your school counselor. Help is available.",
      high: "If you're struggling with thoughts of self-harm, please reach out to a trusted adult or counselor. You don't have to face this alone.",
    },
  },
  {
    key: "hate_speech",
    label: "Hate speech",
    patterns: [
      /\b(?:n[i1]gg?[ae3]r|f[a@]gg?[o0]t|k[i1]ke|ch[i1]nk|sp[i1]c|w[a@]p|tr[a@]nn?[y3])\b/i,
      /\bgo\s+back\s+to\s+(?:your|their)\s+country\b/i,
      /\bgo\s+back\s+to\s+where\s+(?:you|they)\s+came\s+from\b/i,
    ],
    blockThreshold: "high",
    guidance: {
      elementary:
        "Let's keep our conversations respectful. Everyone deserves to be treated kindly.",
      middle: "This language is hurtful and not allowed. Please rephrase respectfully.",
      high: "Hate speech is not acceptable. Please keep your language respectful.",
    },
  },
  {
    key: "sexual_content",
    label: "Sexual content",
    patterns: [
      /\bporn(?:ograph(?:y|ic)?)?\b/i,
      /\bsex\s*(?:chat|cam|ting)\b/i,
      /\bnudes?\b/i,
      /\b(?:send|share)\s+(?:me\s+)?(?:nudes?|pics?)\b/i,
      /\b(?:masturbat|orgasm|genital|erection)\b/i,
    ],
    blockThreshold: "high",
    guidance: {
      elementary:
        "This content isn't appropriate for our learning space. Let's focus on your studies.",
      middle:
        "This content isn't appropriate here. Please keep your questions focused on learning.",
      high: "This content isn't appropriate for our learning space. Please refocus on your studies.",
    },
  },
  {
    key: "violence",
    label: "Violence",
    patterns: [
      /\bi['']?m\s+going\s+to\s+(?:kill|hurt|murder|stab|shoot)\s+(?:you|him|her|them|the\s+\w+|\w+)\b/i,
      /\bhow\s+to\s+(?:make|build)\s+(?:a\s+)?(?:bomb|explosive|weapon|gun|knife)\b/i,
      /\bkill\s+(?:the|your|his|her|a|them|him|you)\s+(?:teacher|student|kid|classmate|principal|person|people|someone|anyone)\b/i,
      /\b(?:kill|murder|shoot|stab|assault)\s+them\b/i,
      /\b(?:want|going)\s+to\s+(?:kill|murder|hurt)\s+(?:you|him|her|them|people|someone)\b/i,
    ],
    blockThreshold: "high",
    guidance: {
      elementary:
        "Threats and talk of violence are never okay. Let's focus on learning in a safe space.",
      middle:
        "Threats of violence are taken seriously. Please rephrase your question appropriately.",
      high: "Threats of violence are not acceptable and may be reported. Please rephrase your question.",
    },
  },
  {
    key: "profanity",
    label: "Profanity",
    patterns: [
      /\b(?:f+u+c+k+(?:ing|er|ed|s)?|shit+(?:ting|ter|s)?|damn+(?:ing|ed)?|ass+(?:hole|es|y|hat)?)\b/i,
      /\b(?:bitch+(?:es|ing|y)?|bastard|crap+(?:py|s)?)\b/i,
    ],
    blockThreshold: "middle",
    guidance: {
      elementary: "Please use school-appropriate language in your questions.",
      middle: "Please use school-appropriate language.",
      high: "Please use appropriate language in your questions.",
    },
  },
  {
    key: "pii_sharing",
    label: "PII sharing",
    patterns: [
      /\+?(?:1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
      /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/,
      /\b\d{16}\b/,
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    ],
    blockThreshold: "high",
    guidance: {
      elementary:
        "Please don't share personal information like phone numbers or addresses. Stay safe online!",
      middle:
        "Please don't share personal information like phone numbers, addresses, or email addresses.",
      high: "Please don't share personal information in your questions for your own safety.",
    },
  },
] as const;

export { levelBlocked };
