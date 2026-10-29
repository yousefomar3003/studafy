/**
 * Server-side twin of `app.search_normalize` (migration 000171) and of the web palette's
 * apps/web/src/features/search/normalize.ts. All three must apply the same rules, or "أحمد" would
 * match in one place and not another:
 *
 * - lowercase;
 * - Arabic diacritics (harakat U+064B–U+065F, superscript alef U+0670) and tatweel (U+0640)
 *   removed;
 * - alef forms unified: أ إ آ ٱ → ا;
 * - alef maqsura ى → ي, and taa marbuta ة → ه;
 * - whitespace collapsed and trimmed.
 */

const ARABIC_MARKS = /[ً-ٰٟـ]/g;
const ALEF_FORMS = /[أإآٱ]/g;

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(ARABIC_MARKS, "")
    .replace(ALEF_FORMS, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalized letter/digit runs of a query. Everything else -- punctuation, symbols, combining
 * marks, and so every tsquery operator (`& | ! ( ) : * < - > '`) -- is a separator, so a token can
 * never carry syntax into `to_tsquery`. `app.search_document` folds the same punctuation on the
 * stored document side, which is what lets "inv-00" find INV-0012.
 */
export function searchTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}
