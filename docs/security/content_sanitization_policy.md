# Content sanitization policy

Sanitization for user-, AI-, and document-derived rich content: announcements, teacher/evaluation
comments, submission text, Ask AI turns, and text extracted from uploaded PDF/DOCX/PPTX files.
Delivered by ST-296.

## The allowlist: empty, on purpose

The sanitizer is [`sanitizePlainText`](../../packages/sanitize/src/plain-text.ts) (`packages/sanitize`),
built on `sanitize-html` with:

```ts
{ allowedTags: [], allowedAttributes: {}, disallowedTagsMode: "escape" }
```

No tag and no attribute is ever admitted. That is not a placeholder for a curated tag list still to
be written — it is the correct policy for this product **today**, verified against both clients:

- **`apps/web`** has no `dangerouslySetInnerHTML` anywhere in the codebase (enforced — see
  [Render guards](#render-guards) below). `react-markdown` is used once, for static first-party help
  articles, with `skipHtml` set explicitly; it is not wired to any user-, AI-, or document-derived
  field.
- **`apps/mobile`** has no `flutter_html` or `webview_flutter` dependency in `pubspec.yaml`. Every
  text field renders through a Flutter `Text` widget, which treats its string as content, never
  markup, by construction.

Every field this sanitizer touches is plain text on both clients. If a future feature needs real
formatting (a rich-text announcement composer, say), that is a new allowlist profile added to
`plain-text.ts` alongside the existing one — not a reason to loosen this one.

`disallowedTagsMode: "escape"` (rather than the library's default, `"discard"`) is the specific
choice that makes this survive real content: a disallowed tag is rewritten to its HTML-entity form
(`<script>` → `&lt;script&gt;`) instead of being deleted outright. A comment that legitimately
mentions markup — "explain what `<p>` does" in an AI tutoring answer, or a computer-science chapter
that quotes a `<script>` tag — keeps its meaning and displays correctly (browsers decode `&lt;` back
to `<` in a text node, which is what every renderer here uses); an actual payload becomes inert text
instead of disappearing without a trace, which would look to the author like the platform silently
ate part of their content.

## Why it lives in its own package

`packages/sanitize` is a standalone workspace package, not a file under `apps/api/src/lib`, because
two independent deployables need it:

- **`apps/api`** sanitizes announcements, teacher/evaluation comments, submission text, and Ask AI
  turns at the request/persistence boundary.
- **`apps/workers`** sanitizes text extracted from an uploaded PDF/DOCX/PPTX at the ingestion write
  boundary, before it reaches `app.material_chunks`.

Neither app's `src` can import the other's — each workspace app depends only on `packages/*`, a rule
with no exception in this repo — so the shared logic has to live in a package rather than be
duplicated (or left unwired on one side). `apps/api/src/lib/sanitize` still exists, but only for the
one thing that genuinely is API-specific: [`sanitizedTextSchema`](../../apps/api/src/lib/sanitize/schema.ts),
a Zod helper that wires `sanitizePlainText` into request-body validation. `apps/workers` imports
`sanitizePlainText` from `@studafy/sanitize` directly.

## Where it runs

| Field(s)                                                      | Schema / call site                                                                                                                                            | Table.column(s)                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `title`, `body`                                               | [`announcements/schemas.ts`](../../apps/api/src/modules/announcements/schemas.ts) — `createAnnouncementBodySchema`                                            | `app.announcements.title`, `.body`              |
| `strengths`, `areas_for_improvement`, `comments`, `narrative` | [`discipline/evaluation-schemas.ts`](../../apps/api/src/modules/discipline/evaluation-schemas.ts) — `createEvaluationBodySchema`/`updateEvaluationBodySchema` | `app.teacher_evaluations.*`                     |
| `content` (student hand-in)                                   | [`academics/submissions/schemas.ts`](../../apps/api/src/modules/academics/submissions/schemas.ts) — `createSubmissionBodySchema`                              | `app.assignment_submissions.content`            |
| `feedback` (teacher grading comment)                          | `academics/submissions/schemas.ts` — `gradeSubmissionBodySchema`                                                                                              | `app.assignment_submissions.feedback`           |
| `question`, `answer` (Ask AI turn)                            | [`ai/ask/persistence.ts`](../../apps/api/src/modules/ai/ask/persistence.ts) — `persistAskMessage`                                                             | `app.ai_messages.question`, `.answer`           |
| `content`, `section_title` (extracted document text)          | [`ai-ingestion/worker.ts`](../../apps/workers/src/queues/ai-ingestion/worker.ts) — `insertChunks`                                                             | `app.material_chunks.content`, `.section_title` |

The first four rows run through [`sanitizedTextSchema`](../../apps/api/src/lib/sanitize/schema.ts), a
Zod helper that wires `sanitizePlainText` into the request-body validation pipeline at the same
point `.trim()`/`.min()`/`.max()` already lived. Ask AI's turn is not a Zod-validated body (it is
assembled from the streamed model output after the fact), so `persistAskMessage` calls
`sanitizePlainText` directly, immediately before the insert. Ingested document text follows the same
"sanitize immediately before the insert" shape: `apps/workers/src/queues/ai-ingestion/parsers`
(`mammoth`/PPTX/PDF) extract plain text from the uploaded file, `chunkBlocks` slices it into
citable chunks with no knowledge of sanitization at all, and `insertChunks` is the one place that
calls `sanitizePlainText` — after chunking and embedding, right before the `INSERT` — so the pure,
fixture-tested parse → chunk → embed pipeline (`buildIngestChunks`) stays untouched.

### Why sanitize runs _before_ the length check, not after

`sanitizedTextSchema` pipes `trim -> sanitizePlainText -> min/max`, in that order:

```ts
z.string().trim().transform(sanitizePlainText).pipe(z.string().min(min).max(max));
```

`disallowedTagsMode: "escape"` can make a string longer than it started — `<script>` is 8
characters, `&lt;script&gt;` is 14. Announcements' `title`/`body` both carry a
`CHECK (char_length(...) <= n)` constraint in the database (migration 000105) matching their Zod
`max`. Validating length on the _raw_ input and sanitizing second could hand storage a value past
that limit despite the request having "passed" — turning a clean 400 into a raw `CHECK` violation.
Sanitizing first means `max` always bounds what actually reaches the row.

Fields that never had a length cap before this ticket (the evaluation narrative fields) are left
uncapped by `sanitizedTextSchema()` — the `max` option is optional precisely so sanitization does
not quietly introduce a new limit on a field whose contract never had one. `app.material_chunks` has
no length cap either (migration 000019: non-empty-after-trim only), so `insertChunks` has nothing to
reorder around — it just sanitizes.

## Render guards

Sanitizing on write is half the defense; the other half is that nothing on either client ever
interprets stored text as markup. That posture is now enforced, not just observed:

- **`studafy/no-unsafe-html-render`** — a custom ESLint rule
  ([`packages/config/rules/no-unsafe-html-render.js`](../../packages/config/rules/no-unsafe-html-render.js),
  wired into the shared config every workspace lints against) — bans `dangerouslySetInnerHTML`,
  `.innerHTML`/`.outerHTML` assignment, and `document.write`/`writeln` monorepo-wide. If a future PR
  tries to render stored content as HTML, it fails lint before it fails review.
- **Mobile has no automated equivalent.** There is no Dart lint-rule tooling (`custom_lint`) in this
  repo yet, and none is needed today: `flutter_html`/`webview_flutter` are not dependencies, so
  rendering a string as HTML is not something `apps/mobile` can currently do at all. **If either
  package is ever added, the PR that adds it must also route any user-, AI-, or document-derived
  content through an equivalent sanitizer (or an allowlisting parser) before it reaches that widget**
  — flag this policy doc in review.

This complements, and does not replace, the transport-level defense already in place: `script-src
'self'` with no `'unsafe-inline'` in the CSP (see [web_defense_matrix.md](./web_defense_matrix.md))
means even a hypothetical unescaped inline `onerror` handler could not execute in a browser session
served by this API.

## Verifying

```bash
cd apps/api
bun test src/lib/sanitize                              # Zod-schema wiring (sanitizer itself moved to packages/sanitize)
bun test src/modules/ai/ask/persistence.test.ts         # Ask AI turn neutralization (needs TEST_DATABASE_URL)
bun test tests/security/content-sanitization.test.ts    # HTTP round-trip probe (needs TEST_DATABASE_URL)

cd packages/sanitize
bun test                                                # sanitizer unit tests (XSS probe corpus)

cd apps/workers
bun test src/queues/ai-ingestion/worker.sanitization.test.ts  # ingested-document neutralization (needs TEST_DATABASE_URL)

cd packages/config
bun test rules/no-unsafe-html-render.test.ts            # render-guard rule
```
