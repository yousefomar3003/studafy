# API changelog

Human-readable log of changes to [`apps/api/openapi.json`](../../apps/api/openapi.json), the
generated HTTP contract. Every pull request that changes that file adds an entry here under
**Unreleased** — CI enforces this (see
[`api-versioning-policy.md`](./api-versioning-policy.md)).

Format loosely follows [Keep a Changelog](https://keepachangelog.com/): group entries as `Added`,
`Changed`, `Removed`, or `Fixed` under a heading. Mark a `Changed`/`Removed` entry **(breaking)**
when it required the `version-bump` label.

## Unreleased

### Added

- Student CSV column mapping and staging (ST-299; see
  [`docs/modules/student-import-mapping-guide.md`](../modules/student-import-mapping-guide.md)):
  - `PUT /api/imports/students/{importId}/mapping` re-maps an unconfirmed import's staged rows,
    with an optional `save_as`.
  - `GET /api/imports/students/{importId}/diff` is the dry-run diff (create / update / unchanged /
    conflict) against live data.
  - `GET|POST /api/imports/students/mappings` and
    `PATCH|DELETE /api/imports/students/mappings/{mappingId}` manage per-school saved column
    mappings.
  - `POST /api/imports/students/upload` takes an optional `mapping_id` query parameter and accepts
    any CSV layout (header row detection, `,`/`;`/tab delimiters).
  - `ImportRecord` gains `confirmed_by`, `header_line`, `source_headers` and `column_mapping`.
  - `ImportSummary` gains optional `students_updated` and `conflicts`.
  - Error codes `IMPORT_MAPPING_NOT_FOUND`, `IMPORT_MAPPING_NAME_EXISTS` and
    `IMPORT_MAPPING_INVALID`.

- `POST /api/subscriptions/webhook/tap` — Tap Payments charge webhooks. Authenticated by the
  `hashstring` HMAC (keyed with the Tap secret key), not a bearer token; the charge is re-read from
  Tap before use. Normalized to the same billing events as the Stripe webhook. ST-298.
- `POST /api/finance/online-payments` — start a hosted online payment for an invoice's full
  outstanding balance, at the payment provider for the school's region (Tap Payments in AE, BH,
  EG, JO, KW, OM, QA, SA; Stripe elsewhere). Open to a parent linked to the student and to staff
  with `billing:update`. ST-298.
- `GET /api/finance/online-payments/{paymentId}` — an online fee payment's status; visible to the
  payer and to staff with `billing:read`. ST-298.
- `501` and `502` problem responses. A `502` on the checkout routes and
  `GET /api/subscriptions/current/invoices` means the payment provider failed; a `501` means the
  school's provider has no equivalent for the operation. ST-298.

- `GET /meta/mobile-versions` — the forced-update floor endpoint from ST-257
  (`GET /api/mobile/config`), also served under this canonical name. Same handler, same schema,
  same unauthenticated posture; `/api/mobile/config` stays mounted unchanged because the released
  native app already calls it. ST-283.
- `POST /api/auth/sessions/revoke-others` — self-service "sign out other sessions": revokes every
  live token family the caller holds except the one behind the presented refresh token (the cookie
  for a web caller, `refresh_token` in the body otherwise), and denylists the access tokens they
  minted. Answers 400 rather than guessing when the current session cannot be identified, since a
  wrong guess would end the very session the request came in on. ST-280.
- `POST /api/announcements` — compose a school/role/class-targeted announcement, published
  immediately or, when `scheduled_at` is in the future, by the workers' publish sweep.
  `mandatory: true` sends as the un-optoutable `ADMIN_ANNOUNCEMENT` type; `mandatory: false` as
  `ANNOUNCEMENT`, which recipients may disable. Callers holding `notification:send` but not
  `notification:manage` may compose only a non-mandatory notice to a class they teach. ST-194 / ST-238.
- `GET /api/announcements` — keyset-paginated school announcement history, newest first, with each
  row's reach snapshot (`recipient_count` / `notified_count`). `notification:manage`. ST-194.
- `POST /api/privacy/dsr` — file a GDPR export or erasure request for one user
  (`PRIVACY_DSR_MANAGE`). ST-268.
- `GET /api/privacy/dsr/{requestId}` — read a data subject request's status and, once a completed
  export, a short-lived download URL. ST-268.
- `POST /api/privacy/me/dsr` — self-service: file a GDPR export or erasure request for the
  caller's own account. Bearer-authenticated only, no permission gate — the subject is always the
  caller, never a body parameter. Backs the mobile app store's account-deletion requirement (Apple
  5.1.1(v) / Google Play Data Safety); see `apps/mobile/store/review-checklist.md`.
- `GET /api/privacy/me/dsr` — the caller's own data subject request history, most recent first.
- `GET /api/ai/health` — unauthenticated black-box check reporting whether the `AI_LLM_ENABLED`
  kill switch is on. Backs the public status page's `ai` component
  (`infra/terraform/modules/monitoring`); deliberately does not call the Anthropic provider. ST-264.
- `GET /api/search` — role-scoped Postgres full-text search across students, users, invoices, and
  materials, grouped per type. A section is populated only when the caller holds that type's own
  read permission (`STUDENT_READ` / `USER_READ` / `BILLING_READ` / `MATERIAL_READ`); row-level
  security within a populated section matches that type's own list endpoint. Every call is
  recorded as a `read` audit entry against `global_search`. ST-278.

### Fixed

- `GET /api/imports/students` never returned a `next_cursor`: it fetched one row past the page and
  then compared the row count against that same inflated limit. It now pages. ST-299.
