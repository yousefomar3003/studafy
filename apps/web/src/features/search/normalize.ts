/**
 * Client-side twin of the API's `app.search_normalize` SQL function (docs/modules/search.md
 * "Matching rules"), used for everything the palette matches without an API call: the destinations
 * registry and the help articles. Both sides must apply the same rules, or "أحمد" would find a page
 * keyword here but not a student there.
 *
 * - lowercase (Latin);
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

/** Normalized words of a query or a haystack, split on anything that is not a letter or digit. */
export function searchTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}
