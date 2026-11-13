import sanitizeHtml from "sanitize-html";

/**
 * ST-296: the sanitizer's one allowlist. No tag, no attribute, is ever admitted.
 *
 * Every field this module sanitizes — announcement title/body, teacher/evaluation comments,
 * submission content, Ask AI question/answer, and text extracted from an uploaded PDF/DOCX/PPTX —
 * is plain text end to end: nothing in `apps/web` or `apps/mobile` renders one through
 * `dangerouslySetInnerHTML`, a WebView, or an HTML-capable widget (see
 * docs/security/content_sanitization_policy.md for the inventory this was verified against). An
 * empty allowlist is therefore not a stand-in for a curated tag list still to be written; it is the
 * correct policy for content nothing ever interprets as markup.
 *
 * `disallowedTagsMode: "escape"` is what makes this a sanitizer rather than a blunt stripper: a
 * disallowed tag is rewritten to its HTML-entity form (`<script>` -> `&lt;script&gt;`) instead of
 * being deleted. The literal characters a user, the model, or an uploaded document typed survive
 * losslessly — including a legitimate "here's what a &lt;script&gt; tag looks like" in an AI
 * explanation — while becoming inert everywhere the result is later displayed, printed, or fed back
 * into a template.
 *
 * This package exists (rather than living under `apps/api/src/lib`) because two independent
 * deployables need it: `apps/api` sanitizes announcements, comments, and Ask AI turns at the request
 * boundary; `apps/workers` sanitizes text extracted from uploaded documents at the ingestion write
 * boundary (`apps/workers/src/queues/ai-ingestion/worker.ts`). Neither app's `src` can import the
 * other's, so the shared logic lives here instead of being duplicated.
 */
const PLAIN_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: "escape",
};

/**
 * Neutralize HTML/script markup in a plain-text field, trimming the result.
 *
 * Apply this to every user-, AI-, or document-derived string before it is persisted (see the write
 * paths listed in docs/security/content_sanitization_policy.md). It is idempotent: sanitizing
 * already-sanitized text is a no-op past the first pass.
 */
export function sanitizePlainText(input: string): string {
  return sanitizeHtml(input, PLAIN_TEXT_OPTIONS).trim();
}
