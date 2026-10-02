# AI data sharing & consent (ST-305)

What the app sends to the third-party AI model provider, how the user is asked, where the answer is
recorded, and how it is enforced and withdrawn. Covers Apple App Store Review Guideline 5.1.2(i):
an app must clearly disclose where personal data will be shared with third parties, including
third-party AI, and obtain explicit permission before doing so.

## Who receives what

Studafy's AI features are served by **Anthropic** (the only model provider: `apps/api`'s
`modules/ai/llm/provider.ts`, and the exam-generation worker's `anthropic-client.ts`). The app never
calls Anthropic directly — the API does, on the user's behalf. What reaches Anthropic:

| Category (`AI_DATA_CATEGORIES`) | What it is                                                                                                   | Sent by                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `questions`                     | Text the user types: Ask AI questions, `/generate` prompts                                                   | ask, generate                                             |
| `study_materials`               | Extracted text of the materials a feature runs on (plus the title, for summaries) — may contain names or other personal details | summarize, concepts, explain, quizzes, decks, exams       |
| `account_identifier`            | The user's opaque Studafy user id as `metadata.user_id` (abuse monitoring); never a name or email. Not sent when the deployment runs zero-retention (`AI_LLM_ZERO_RETENTION`, see `docs/runbooks/anthropic-provider-config.md`) | every model call |

No prompt includes the student's name, email, grades, or attendance programmatically. Hybrid search
(`/search`) uses a local deterministic embedder and never leaves Studafy.

The disclosure lives in one place — `apps/api/src/modules/ai/consent/disclosure.ts` — and the app
renders it as served by `GET /api/ai/consent`. **Changing the provider or the categories must bump
`AI_DATA_SHARING_DISCLOSURE.version`**: consent is only honoured for the current version, so a bump
re-prompts every user.

## Flow

1. **Modal.** Every AI feature screen (Ask AI, quizzes, flashcards, exam mode, summaries, key
   concepts) is wrapped in `AiConsentGate` (`features/ai/presentation/widgets/ai_consent_gate.dart`).
   Without consent the feature screen is never built; the consent modal opens on arrival, naming the
   provider and each data category, with a link to the provider's privacy policy. "Allow" and
   "Don't allow" are both explicit; the modal can't be dismissed by tapping outside.
2. **Record.** "Allow" calls `PUT /api/ai/consent` with the disclosure version that was on screen.
   The API refuses a version it no longer serves (`409 AI_CONSENT_DISCLOSURE_OUTDATED`); the modal
   then closes without consent so the user reads the new disclosure first.
3. **Enforce.** `aiConsentGate` (`apps/api/src/modules/ai/gate/consent-gate.ts`) runs before the
   quota gate on `/api/ai/*` and refuses every model-calling route with `403 AI_CONSENT_REQUIRED`
   unless the caller has a live consent to the current disclosure. This is what makes "nothing
   leaves before consent" true for every client — iOS, Android, web, or a hand-rolled request — not
   just for screens that remembered to show the modal. Routes that never reach the provider (usage,
   search, grading, reviews, exam status, answer reports) are not gated.
4. **Withdraw.** AI tab → privacy icon in the app bar → **AI data sharing**
   (`ai_data_sharing_screen.dart`, route `/me/ai/data-sharing`) shows the disclosure, when consent
   was given, and "Withdraw consent" (with confirmation) → `DELETE /api/ai/consent`. The next
   model-calling request is refused, and every gated screen relocks at once (they share
   `aiConsentProvider`). The page is reachable in every hub state and `/api/ai/consent` bypasses the
   entitlement gate, so withdrawal never depends on an active AI add-on.

## Storage and audit

`app.ai_data_sharing_consents` (migration `000117`): one row per grant with the disclosure
snapshot (`disclosure_version`, `provider`, `data_categories`), `granted_at`, and `withdrawn_at`.
Withdrawal stamps the row instead of deleting it (the app role has no `DELETE`), so the table is the
user's full consent history; a partial unique index allows one live row per user. Every grant and
withdrawal also writes an `app.audit_logs` row in the same transaction (grant: `insert`, with user
agent; withdrawal and supersession: `update` of `withdrawn_at`). Tenant-isolated by RLS like every
other `app.*` table.

## Known limits

- **Withdrawal is not retroactive.** Inputs already sent to Anthropic are not recalled, and Ask AI
  history Studafy stores itself (`app.ai_messages`, 90-day retention) is not deleted on withdrawal.
  The withdrawal dialog says the first; deleting stored history is the DSR/account-deletion path.
- **Consent is per user, given by that user.** There is no parental-consent step for minors. Whether
  the school's authorization covers AI processing for children is an open question for counsel in
  `docs/compliance/childrens-data-dossier.md` (ST-309).
- **Mid-session withdrawal on another device.** An open AI screen on this device keeps its state
  until its next request, which the API refuses (`403 AI_CONSENT_REQUIRED`, shown as a generic
  error by the feature screens); the gate reflects it the next time `aiConsentProvider` reloads.
- **Web.** `apps/web` has no AI feature UI today, and this Flutter app has no web target configured
  (`apps/mobile` has no `web/` directory). The server-side gate already covers any web client; the
  Flutter UI above is platform-agnostic Material and needs no change for a web build.
