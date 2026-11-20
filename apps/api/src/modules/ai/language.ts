/**
 * Which language a model answers in, and the rule that keeps it there.
 *
 * Small multilingual models (production runs Qwen3.5-9B) drift into another language mid-answer,
 * most visibly Chinese words inside an Arabic answer, when the prompt does not pin the language.
 * Every model-calling prompt therefore carries one of the rules below, and `llm/script-guard.ts`
 * removes any Chinese, Japanese or Korean characters that still slip through.
 */

import type { SupportedLocale } from "../../middleware/locale";

export type ReplyLanguage = "ar" | "en";

const ARABIC_WORD = /\p{Script=Arabic}+/gu;
const LATIN_WORD = /[A-Za-z]+/g;

/**
 * The language to answer a student's message in: the script most of its words are written in, or
 * the app's language when the message has no words to go by (a formula, an emoji). Words, not
 * letters, so an Arabic question naming one long English term ("ما هو photosynthesis؟") is Arabic.
 */
export function replyLanguageFor(message: string, locale: SupportedLocale): ReplyLanguage {
  const arabic = message.match(ARABIC_WORD)?.length ?? 0;
  const latin = message.match(LATIN_WORD)?.length ?? 0;
  if (arabic === 0 && latin === 0) return locale;
  return arabic >= latin ? "ar" : "en";
}

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
  ar: "Arabic (Modern Standard Arabic, in Arabic script)",
  en: "English",
};

/** For a chat answer: the student's own language, whatever language the sources are in. */
export function replyLanguageRule(language: ReplyLanguage): string {
  return (
    `Write your whole answer in ${LANGUAGE_NAME[language]}, even when the sources are in another ` +
    "language. A technical term, formula or name may stay in its original form, but never write " +
    "Chinese, Japanese or Korean characters and never switch language part-way through."
  );
}

/** For a study tool built from a material (summary, quiz, flashcards...): the material's language. */
export const SOURCE_LANGUAGE_RULE =
  "Write in the same language as the source material (Arabic material gets Modern Standard " +
  "Arabic in Arabic script). Never write Chinese, Japanese or Korean characters and never switch " +
  "language part-way through.";
