# AI Content Moderation Runbook

How reported and filter-blocked AI output is handled (ST-306): who looks at it, how fast, and what to
do when it involves a child. Written for the school moderator working the queue and for Studafy
on-call. It also records what the system does **not** do yet, so no one relies on a safeguard that is
not there.

## What exists

| Piece                   | Where                                                                         | What it does                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety filter           | `apps/api/src/modules/ai/moderation/policy.ts`, `moderate.ts`                 | Pattern match on text in 7 categories: `csam`, `self_harm`, `hate_speech`, `sexual_content`, `violence`, `profanity`, `pii_sharing`.                                                                                                  |
| Where it runs           | `ask-routes.ts`, `quiz-routes.ts`, `flashcard-routes.ts`, `summary-routes.ts` | Ask AI: on the question and on the answer. Quiz, flashcards, summary: on the generated output, before anything is saved, cached, or shown. A block returns `AI_MODERATION_OUTPUT_BLOCKED` (422) and the student is not charged quota. |
| Audit trail             | `app.ai_moderation_decisions`                                                 | One row per block: surface, phase, category, sha-256 of the text (never the text).                                                                                                                                                    |
| Child-safety escalation | `moderation/enforce.ts`                                                       | A `csam` block also files an **urgent** report into the queue with the blocked text, and logs `event: "ai_moderation_escalation"` at error level (no text in the log).                                                                |
| Report action           | Mobile: flag button on Ask AI answers, quizzes, flashcard decks, summaries    | `POST /api/ai/students/{studentId}/reports`. The student picks a reason; the server reads the reported content itself and snapshots it. Works even if the student's AI add-on has lapsed.                                             |
| Moderation queue        | `GET/PATCH /api/ai/moderation/reports[/{reportId}]`, `app.ai_content_reports` | School-scoped queue ordered urgent-first, then by deadline, with an `overdue` flag. Requires `aiContent:moderate` (ORG_ADMIN, SUPER_ADMIN). Reading a report's content and every status change are written to `app.audit_logs`.       |

## Who moderates

- **School moderator** — the school's designated safeguarding lead, holding the ORG_ADMIN role. Teachers
  do not have `aiContent:moderate` on purpose: the queue covers the whole school and can hold
  child-safety material.
- **Studafy on-call** (SUPER_ADMIN) — owns the filter, the alert on `ai_moderation_escalation`, and
  platform-level reporting to authorities when a school cannot.

## Response targets

Set at filing time from the reason (`moderation/reports.ts`, `REPORT_RESPONSE_HOURS`); change both
together.

| Reason the student picked                                                     | Priority | Respond within |
| ----------------------------------------------------------------------------- | -------- | -------------- |
| Sexual content involving a child (`child_safety`), or a filter escalation     | urgent   | 24 hours       |
| Harmful or dangerous (`unsafe`), offensive or inappropriate (`inappropriate`) | high     | 48 hours       |
| Wrong or misleading (`inaccurate`), something else (`other`)                  | normal   | 5 days         |

"Respond" means the report has left `pending`/`in_review` for an outcome, or is `escalated` with the
external reference recorded.

## Working the queue

1. `GET /api/ai/moderation/reports` — open reports (pending, in review, escalated), urgent first. The
   list does not include the reported text.
2. `PATCH .../reports/{id}` with `{"status": "in_review"}` to claim it, so a second moderator sees it
   is taken.
3. `GET .../reports/{id}` to read `content_snapshot` — the exact text the model produced. This read is
   audit-logged.
4. Close it with a `resolution_note` (required for every status except `in_review`):
   - `actioned` — the report was valid and something was done (e.g. the material that produced it was
     fixed or removed, the student's teacher was told about a wrong answer).
   - `dismissed` — the content was fine.
   - `escalated` — handed to an outside authority; see below. Close it later as `actioned` with the
     outcome.

Closed reports cannot be reopened (`409 AI_REPORT_INVALID_TRANSITION`); file a new note in your own
case system if new information arrives. If two moderators act at once, the second gets the same 409.

## Child-safety (CSAM) escalation

Applies to any `urgent` report and to every `source: safety_filter` row.

1. **Do not copy, forward, screenshot, download, or re-share the content** — not to colleagues, not to
   Studafy support, not by email. The snapshot stays where it is; it is the preserved evidence.
2. Move the report to `in_review` immediately.
3. Decide whether it is child sexual abuse material or an attempt to obtain it. Note that Studafy only
   generates **text**; the filter matches text.
4. If it is, or you cannot rule it out:
   - Report to the authority for the school's jurisdiction: the national hotline or law enforcement
     (the INHOPE member directory at inhope.org lists national hotlines). For US-based reporting, the
     channel is the NCMEC CyberTipline (report.cybertip.org).
   - Tell Studafy on-call through the incident channel, giving **only the report id**, never the
     content.
   - If a specific child may be at risk (e.g. a student's own question suggests they are being
     groomed or exploited), follow the school's safeguarding procedure for that child in parallel.
     This is a human decision; the system does not notify anyone about the student.
5. `PATCH` to `escalated` with a `resolution_note` naming the authority and its reference number.
6. When the authority has what it needs, `PATCH` to `actioned` with the outcome.

Which legal reporting obligations apply to the school and to Studafy depends on jurisdiction; get
counsel's answer before launch in each market rather than relying on this runbook.

**Studafy on-call, when `ai_moderation_escalation` fires:** confirm the school's moderator knows (the
queue row is already there), check whether the same `school_id` is producing repeated escalations
(a material or a prompt pattern that keeps generating it), and if the source is a study material,
coordinate with the school to have it removed. Do not open the snapshot unless the school cannot
act and the report must be made at platform level.

## Other harms

- **Self-harm** blocks are logged but not escalated to the queue — the student sees counsellor
  guidance. A student _reporting_ content as `unsafe` does reach the queue as high priority. If a
  report suggests a student is at risk, follow the school's safeguarding procedure.
- **Wrong answers** (`inaccurate`) are the common case: check the snapshot against the cited
  material, fix or flag the material, close as `actioned` or `dismissed`.

## Store policy mapping

- **Apple App Store Guideline 1.2 (User-Generated Content)** asks for a filter for objectionable
  material, a mechanism to report offensive content with timely responses, and published contact
  information. Here: the safety filter, the in-app Report action on every surface listed above, the
  response targets in this runbook, and the store listing's Support URL (checked in
  `apps/mobile/store/review-checklist.md`). 1.2's "block abusive users" item has no equivalent: AI output is not written by another
  user.
- **Google Play generative-AI policy** requires in-app reporting of offensive AI-generated content
  without leaving the app, and prevention of prohibited content. Here: the same Report action and
  generation-side filter.
- `apps/mobile/store/review-checklist.md` points reviewers at this runbook.

## Known gaps (not yet built)

Stated plainly so they are not assumed covered:

- **The filter is English regex only.** It does not detect Arabic or other languages, misspellings
  beyond the patterns listed, or meaning without keywords. It is a floor, not a classifier. The
  `ModerationProvider` interface in `moderate.ts` is the seam for a model- or API-based classifier.
- **Not every AI surface is covered.** Key concepts, simplified explanations, and exam mode (generated
  in `apps/workers`) have no Report action and no output filter yet.
- **Summary reports depend on the Redis cache.** Summaries are never stored in Postgres; a report is
  accepted only while the summary the student saw is still cached (24 h, `AI_SUMMARY_CACHE_TTL_SECONDS`).
  After that the report returns 404 rather than trusting text from the client.
- **No notification to moderators.** Nothing pushes or emails a school moderator when a report
  arrives; they must check the queue. Meeting the 24-hour urgent target depends on that habit.
- **No alert rule is wired yet** for the `ai_moderation_escalation` / `ai_content_report_urgent` log
  events; one needs adding to `infra/terraform/modules/monitoring/alerts.tf` with an entry in
  `alert-catalog.md`.
- **No moderation UI.** The queue is API-only; there is no web admin screen for it yet.
- The age band used for filtering on quiz, flashcards, and summary is fixed at `high` (the most
  permissive), because those routes do not receive the student's age band. Every category except
  `profanity` blocks at every band, so this only lets mild profanity through for younger students.
