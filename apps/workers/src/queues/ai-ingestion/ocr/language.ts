/**
 * One language-detection pass: how confidently Tesseract read the image in a given language.
 */
export interface LanguagePass {
  language: string;
  confidence: number;
}

/**
 * Choose the winning pass of a language-detection run.
 *
 * Confidence is the only signal that survives from the recognizer without inventing heuristics, so
 * the best pass is simply the most confident one. Returns `null` for an empty list, which callers
 * treat as "no readable text".
 */
export function pickBestLanguage<T extends LanguagePass>(passes: readonly T[]): T | null {
  if (passes.length === 0) return null;
  return passes.reduce((best, pass) => (pass.confidence > best.confidence ? pass : best));
}
