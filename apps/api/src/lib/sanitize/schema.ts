import { z } from "@hono/zod-openapi";
import { sanitizePlainText } from "@studafy/sanitize";

export interface SanitizedTextOptions {
  /**
   * Upper bound on the *sanitized* string's length — see the ordering note below. Omit it to leave
   * the field as unbounded as it was before sanitization was added (some fields, e.g. evaluation
   * narratives, never had a cap; this helper does not impose a new one on their behalf).
   */
  max?: number;
  /** Lower bound on the sanitized string's length. Defaults to 0 (no minimum). */
  min?: number;
  /** Custom message for the `min` check, matching the convention of the field it replaces. */
  minMessage?: string;
}

/**
 * A trimmed, sanitized text field: `sanitizePlainText` runs *before* `min`/`max` are checked, not
 * after.
 *
 * That ordering is load-bearing, not stylistic. `disallowedTagsMode: "escape"` can make a string
 * longer than it started (`<script>` is 8 characters, `&lt;script&gt;` is 14) — so bounding the raw
 * input first and sanitizing second could hand storage a value past the intended limit despite the
 * request having validated. Piping trim -> sanitize -> length-check means `max` always bounds what
 * actually reaches the database (and a `CHECK (char_length(...) <= max)` constraint sized to match),
 * exactly as the field's contract promises the caller.
 */
export function sanitizedTextSchema(options: SanitizedTextOptions = {}) {
  const { max, min = 0, minMessage } = options;
  const bounds = z.string().min(min, minMessage);
  return z
    .string()
    .trim()
    .transform(sanitizePlainText)
    .pipe(max === undefined ? bounds : bounds.max(max));
}
