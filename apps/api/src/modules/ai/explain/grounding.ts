/**
 * Grounding validator for simplified explanations (ST-170).
 *
 * The acceptance criterion "the rewrite is grounded in the retrieved passage" is enforced here,
 * deterministically, after the provider answers: every sentence of the explanation must share at
 * least one significant word with the passage it was handed. A sentence that shares none — whose
 * content words are all new to the source — has drifted out of the passage, so the route rejects
 * the whole generation rather than silently shipping an ungrounded sentence. This is the same
 * strict posture `concepts/grounding.ts` and `quiz/parser.ts` take: one ungrounded unit means the
 * output cannot be trusted.
 *
 * "Significant word" excludes the language's function words (the stopword list) and words shorter
 * than three letters, because they cannot tie a sentence to a topic. A sentence with no
 * significant words at all is vacuously grounded — "However," or "Yes." carry no content, so there
 * is nothing to hallucinate. The match is deliberately mechanical, not semantic: inflections are
 * folded via a bounded prefix match (run/runs/running, cell/cells) but an open-ended substring
 * match is not used, so art/article or man/manage — prefix neighbours that share three letters —
 * are also folded in. That is the accepted trade-off for a backstop: the prompt already keeps the
 * model on the source, so a rare over-match is harmless, while a too-strict matcher would reject
 * faithful paraphrases and turn into spurious 503s.
 */

/** English function words; a word on this list cannot ground a sentence. */
const STOPWORDS = new Set([
  "about",
  "above",
  "across",
  "after",
  "again",
  "against",
  "all",
  "along",
  "also",
  "an",
  "and",
  "any",
  "are",
  "around",
  "as",
  "at",
  "be",
  "been",
  "before",
  "behind",
  "being",
  "below",
  "between",
  "beyond",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "during",
  "each",
  "few",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "if",
  "in",
  "inside",
  "into",
  "is",
  "it",
  "its",
  "just",
  "may",
  "me",
  "might",
  "more",
  "most",
  "much",
  "must",
  "my",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "out",
  "outside",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "toward",
  "under",
  "until",
  "up",
  "upon",
  "us",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "yes",
  "you",
  "your",
  "yours",
]);

/** Fold text for word extraction: lowercase and collapse every run of whitespace to one space. */
function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

/** The significant words of a text, deduplicated. */
function significantWords(text: string): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const match of fold(text).match(/[a-z]+/g) ?? []) {
    if (match.length < 3 || STOPWORDS.has(match)) continue;
    if (!seen.has(match)) {
      seen.add(match);
      words.push(match);
    }
  }
  return words;
}

/**
 * True when one word is the other's stem plus a short inflection: the shorter is a prefix of the
 * longer and adds at most four characters (run→running, convert→converts, process→processes).
 * Exact equality is a match, too. Longer prefixes stop being inflections and start being different
 * words, so the prefix is never used open-ended.
 */
export function wordsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && longer.startsWith(shorter) && longer.length - shorter.length <= 4;
}

function sentenceIsGrounded(
  sentenceWords: readonly string[],
  sourceWords: readonly string[],
): boolean {
  if (sentenceWords.length === 0) return true;
  // Exact hits are the common case, so check them against a set before the O(n·m) inflection scan.
  const sourceSet = new Set(sourceWords);
  if (sentenceWords.some((word) => sourceSet.has(word))) return true;
  return sentenceWords.some((word) =>
    sourceWords.some((sourceWord) => wordsOverlap(word, sourceWord)),
  );
}

/**
 * The model output failed validation or grounding; the route rejects it with
 * `AI_EXPLAIN_GENERATION_FAILED` and, deliberately, does not commit the generation to quota.
 */
export class ExplainGenerationInvalidError extends Error {}

/** The first ungrounded sentence, or null when every sentence of the explanation is grounded. */
export function firstUngroundedSentence(explanation: string, sourceText: string): string | null {
  const sourceWords = significantWords(sourceText);
  if (sourceWords.length === 0) return null;

  for (const sentence of explanation.split(/[.!?]+/)) {
    const words = significantWords(sentence);
    if (!sentenceIsGrounded(words, sourceWords)) return sentence.trim();
  }
  return null;
}

/** True when every sentence of the explanation shares the passage's vocabulary. */
export function isExplanationGrounded(explanation: string, sourceText: string): boolean {
  return firstUngroundedSentence(explanation, sourceText) === null;
}
