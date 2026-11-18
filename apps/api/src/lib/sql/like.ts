/**
 * A "contains" pattern for LIKE/ILIKE that matches `value` literally (QA-068): `\`, `%` and `_` are
 * escaped with a backslash, Postgres's default LIKE escape character, so a search for `first_last`
 * does not also match `firstxlast`, and `%` cannot widen a search to everything.
 */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
