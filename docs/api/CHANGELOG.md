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

- Global search covers twenty record types (`GET /api/search`, migration 000170):
  - Named query enum `SearchType` (`students`, `users`, `invoices`, `materials`, `classes`,
    `sections`, `subjects`, `grade_levels`, `academic_years`, `terms`, `rooms`, `families`,
    `announcements`, `events`, `incidents`, `evaluations`, `fee_structures`, `scholarships`,
    `expenses`, `notifications`); `SearchQuery` gains `types` (array of `SearchType`, repeated or
    comma-separated; omitted = all) and `offset` (0–1000, default 0).
  - `GlobalSearchResult` gains `types` (the requested `SearchType[]`, echoed) and `totals`
    (`GlobalSearchTotals`, one integer per type: total matches the caller can see, 0 when not
    requested or not permitted). `results` is now the named `GlobalSearchResults` and always carries
    all twenty arrays.
  - New hit schemas: `ClassSearchHit`, `SectionSearchHit`, `SubjectSearchHit`,
    `GradeLevelSearchHit`, `AcademicYearSearchHit`, `TermSearchHit`, `RoomSearchHit`,
    `FamilySearchHit`, `AnnouncementSearchHit`, `EventSearchHit`, `IncidentSearchHit`,
    `EvaluationSearchHit`, `FeeStructureSearchHit`, `ScholarshipSearchHit`, `ExpenseSearchHit`,
    `NotificationSearchHit`. Each section is gated by the permission its own list endpoint requires
    (incidents: `principalDashboard:view` and `disciplineIncident:read`; notifications: the
    caller's own inbox) and narrowed by the same row scope.

- School-defined student and parent records (see
  [`docs/modules/student-records.md`](../modules/student-records.md)), tag "Student and parent
  records":
  - Template editor (`recordTemplate:manage`): `GET /api/record-templates/{subjectKind}`,
    `POST …/fields`, `PATCH …/fields/{fieldId}` (edit or `archived`), `PUT …/field-order`,
    `POST …/publish` (`RecordTemplate`, `RecordTemplateField`, `CreateRecordFieldBody`,
    `UpdateRecordFieldBody`, `ReorderRecordFieldsBody`, `RecordTemplateVersion`). 409
    `RECORD_FIELD_LOCKED` for a published field's type or a sensitive field made standard; 409
    `RECORD_NOTHING_TO_PUBLISH`.
  - `GET /api/record-forms/{subjectKind}` (`studentRecord:update`): the published form (`RecordForm`,
    `RecordFieldDefinition`).
  - Records for `/api/students/{studentId}` and `/api/parents/{parentUserId}`: `GET`/`PUT …/records`
    (`SubjectRecords`, `RecordEntry`, `UpdateRecordsBody`, `RecordAnswerInput`, `RecordValue`);
    `POST …/records/{fieldId}/reveal` (`studentRecord:readSensitive`, audited, `RevealedRecordValue`);
    `PUT`/`PATCH`/`DELETE …/records/{fieldId}/document` and `GET …/document/download`
    (`AttachRecordDocumentBody`, `UpdateRecordDocumentBody`, `RecordDocument`,
    `RecordDocumentDownload`). Sensitive values are always `value: null` with a `mask` outside the
    reveal call. Record responses carry `Cache-Control: no-store`.
  - Missing information (`studentRecord:read`): `GET /api/records/missing/students`,
    `…/parents`, `…/summary` (`RecordMissingQuery` with the named `RecordMissingIssue` filter,
    echoed as `issue`; `RecordMissingStudentList`, `RecordMissingParentList`, `RecordMissingSummary`).
  - `POST /api/students` and `POST /api/users` (PARENT only): optional `records`
    (`RecordAnswerInput[]`), written in the same transaction; needs `studentRecord:update`.
  - Storage content classes `record.document` and `record.sensitiveDocument` for
    `POST /api/storage/uploads/request-upload`.
  - Error codes `RECORD_TEMPLATE_NOT_PUBLISHED`, `RECORD_NOTHING_TO_PUBLISH`,
    `RECORD_FIELD_NOT_FOUND`, `RECORD_FIELD_INVALID`, `RECORD_FIELD_LOCKED`,
    `RECORD_FIELD_NOT_DOCUMENT`, `RECORD_FIELD_NOT_SENSITIVE`, `RECORD_VALUE_INVALID`,
    `RECORD_SUBJECT_NOT_FOUND`, `RECORD_DOCUMENT_NOT_FOUND`, `RECORD_KEY_UNAVAILABLE`.
  - Student import: `StudentImportColumnMapping.records` (template field id -> source column),
    `ImportDiffRow.records` (`ImportDiffRecordValue`, sensitive values masked),
    `ImportDiffRow.parent_conflict`, `parent_group_line`, `parent_email`, `parent_name`,
    `ImportDiff.totals.parent_conflicts`, and `ImportSummary.parent_conflicts` / `record_answers`.

- Linking parents and children (see
  [`docs/modules/finance-module-guide.md`](../modules/finance-module-guide.md#how-parents-and-children-get-linked)):
  - `POST /api/users`: optional `children` (`CreateUserChild`: `student_id`, `relationship`) links a
    new PARENT to students in the same transaction. It is refused with 400 for any other role or a
    student listed twice, with 404 for a student outside the school (nothing is created), and with 403
    without `parent:link`. The response now documents 404.
  - `GET /api/finance/unlinked/students`, `GET /api/finance/unlinked/parents` and
    `GET /api/finance/unlinked/summary` (`billing:read`): enrolled students with no guardian and
    PARENT accounts with no children, searchable and offset-paginated (`FinanceUnlinkedQuery`;
    `FinanceUnlinkedStudentList`, `FinanceUnlinkedParentList`, `FinanceUnlinkedSummary`).
  - `POST /api/finance/invoices/batches/preflight` (`billing:read`, writes nothing): resolves a
    batch's targets (`InvoiceBatchPreflightBody`, same rules as `CreateInvoiceBatchBody`) and
    reports `total_count`, `unlinked_count` and the first 100 `unlinked_students`
    (`InvoiceBatchPreflight`, `InvoiceBatchUnlinkedStudent`).

- Paid features and school licensing (see
  [`docs/billing/feature-licensing.md`](../billing/feature-licensing.md)):
  - `GET /api/me/features`: the caller's paid features with their verdicts.
  - School licenses and seats: `/api/school/license` (overview, seats, eligible people, change
    requests) and the super admin's `/api/platform/schools/{schoolId}/licenses` console.
  - License billing: the school's quotes, invoices, receipts and payments under
    `/api/school/license/{quotes,invoices,payments,receipts}`; the super admin's price settings,
    bank details, calculator (`POST /api/platform/licenses/quote`), cross-school invoices, pending
    receipts and finance totals under `/api/platform/licenses/*`, and quotes, invoices, payments and
    receipts under `/api/platform/schools/{schoolId}/license-*`.
  - AI routes answer `429 FEATURE_LIMIT_REACHED` when a tier's monthly unit limit is used up.
  - The super admin's license console: `GET /api/platform/features`,
    `PATCH /api/platform/features/{featureKey}`, `GET`/`POST /api/platform/tiers`,
    `PUT /api/platform/tiers/{planId}`, `GET /api/platform/licenses` (across schools, with
    expiring / nearly-full / unpaid filters), `GET /api/platform/licenses/change-requests`,
    `GET /api/platform/licenses/usage` and `GET /api/platform/schools/{schoolId}/license-console`.
  - The school's side: `GET /api/school/license/people` (everyone in an audience with their seat
    and personal subscription end date) and `GET /api/school/license/tiers` (what each tier gives,
    without prices).
- Finance family accounts (`/api/finance/families`, payments, profile, reminders, statements),
  payment receipts (`GET /api/finance/payments/{paymentId}/receipt`), reminders and the sibling
  discount (`/api/finance/sibling-discount`).
- Year-scoped academic grading under `/api/grading/*`: scales, programs, subject configs, teacher
  assignments, mark sheets and marks, results preview and finalization, certificates.
- Public account deletion without the app or a session (ST-302; see
  [`docs/modules/account-deletion.md`](../modules/account-deletion.md#web-deletion-flow-no-sign-in)).
  Both unauthenticated (`security: []`), CSRF-exempt and `auth-strict` rate-limited:
  - `POST /api/account/deletion-requests` (`AccountDeletionRequest`: `email`, `captcha_token`)
    emails a one-hour, single-use deletion link if the address has accounts. Always `202` with the
    same `AccountDeletionRequestAccepted` body, so it does not disclose whether an address is
    registered. `400 CAPTCHA_INVALID` on a failed Turnstile check.
  - `POST /api/account/deletion-requests/confirm` (`AccountDeletionConfirm`: `token`) deletes every
    active account under that address through the same pipeline as `POST /api/account/deletion`,
    answering `202` with `AccountDeletionConfirmed`: `accounts[]` (`school_name`, `request_id`,
    `completes_by`) and `retained_records`. `400 VERIFICATION_TOKEN_INVALID` for an unknown,
    expired or used token.
- `POST /api/account/deletion` — self-service account deletion (ST-301; see
  [`docs/modules/account-deletion.md`](../modules/account-deletion.md)). Bearer-authenticated
  only; the caller is the subject. Signs out every session, detaches the account from the school,
  stops AI add-on billing and files an erasure request, answering `202` with an `AccountDeletion`
  body: `request_id`, `status`, `requested_at`, `completes_by`, `ai_subscriptions_canceled` and
  `retained_records` (`RetainedRecord`: `category`, `description`, `legal_basis`). New `Account`
  tag and error code `APPLE_TOKEN_REVOCATION_FAILED`.
- `POST /api/auth/login/review`: email/password login for the App Store / Play reviewer demo
  tenant only (ST-303; see [`docs/runbooks/app-review-access.md`](../runbooks/app-review-access.md)).
  Public, rate-limited `auth-strict`, and answers 404 unless `REVIEW_LOGIN_PASSWORD` is configured.
  Returns the same token pair as `POST /api/auth/login/oauth`, whose response schema it reuses.
- Error code `REVIEW_TENANT_BILLING_DISABLED` (403), returned by school checkout and online fee
  payment for the reviewer demo tenant.
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

### Changed

- `GET /api/search` matching: the phrase is normalized (case, Arabic harakat/tatweel, alef forms,
  ى → ي, ة → ه), split into letter/digit words and matched as all of them with the last one as a
  prefix (`oma` → Omar, `inv-00` → INV-0012), replacing `websearch_to_tsquery`; names fall back to
  trigram matching (word similarity ≥ 0.5) when nothing matches exactly (for students, classes
  and subjects: nothing in the whole school, so a name outside the caller's scope gives an empty
  section rather than look-alikes). Existing hit shapes are
  unchanged; `rank` is the trigram similarity for a typo match. The audit entry also records
  `types`, `offset` and per-type `totals`.

- Student import no longer matches parents by email (see
  [`docs/modules/finance-module-guide.md`](../modules/finance-module-guide.md#how-parents-and-children-get-linked))
  **(breaking)**: `ImportDiffRow.parent` is now `create | sibling | conflict` (`existing` is gone);
  a `parent_email` that belongs to an existing account is `parent: "conflict"` with
  `parent_conflict: "PARENT_ACCOUNT_EXISTS"`, and the student is still imported with no link.
  `ImportDiffRow.link` is now `create` or null (`update` / `unchanged` are gone).
  `ImportDiff.totals.links_updated` is replaced by `parent_conflicts`.
  `PARENT_EMAIL_BELONGS_TO_STUDENT` now means only a new student in the same file; a live
  student's email is `PARENT_ACCOUNT_EXISTS`.

- `POST /api/students`: `guardians` now require `parent:link` on top of `student:create` (403
  otherwise). Each guardian is linked through the same checked, audited path as
  `POST /api/students/{studentId}/guardians`, so an unknown parent is now 404 (it was 400) and a
  parent listed twice is 400. The response now documents 404. Every role that can create students
  already holds `parent:link`.
- `POST /api/school/license/change-requests` also takes `studentPlanId` / `teacherPlanId` /
  `parentPlanId` (a tier wanted per audience), and every `LicenseChangeRequest` now carries
  `studentTier` / `teacherTier` / `parentTier`.
- `GET /api/me/features` adds `schoolName` and, per feature, `schoolSeat`, `schoolOffers` and
  `renewalStop`.
- `GET /api/subscriptions/ai/offer` adds `schoolSeat` and `schoolOffers` per student;
  `POST /api/subscriptions/ai/checkout` answers `409 AI_SUBSCRIPTION_COVERED_BY_SCHOOL` for a
  student holding a school-license seat.
- `POST /api/account/deletion` now also emails the account a confirmation (`account.deleted`
  outbox event), and its audit entry records `source: "account_settings"` (`"web_request"` for the
  public flow above). No change to the HTTP contract. ST-302.
- `POST /api/subscriptions/checkout` is now web-origin only, like every other subscription purchase
  route: a `mobile` or `api` session gets `403 CHANNEL_NOT_AUTHORIZED` (already a documented
  response). The app stores forbid a native app from starting an outside purchase of a digital
  good; no client called it from mobile. ST-304 (see
  [`apps/mobile/docs/store_payment_routing.md`](../../apps/mobile/docs/store_payment_routing.md)).

### Fixed

- `POST /api/students` with `guardians` wrote no `parent_child_links` audit row; it now writes one
  per link, like the Guardians tab.
- `GET /api/teachers/me` answered `403 CHANNEL_NOT_AUTHORIZED` to mobile sessions (and required
  `TEACHER_READ`), because the web-only `/api/teachers/{teacherId}` guards matched `me` as an id.
  The id is now constrained to a UUID; `/me` is reachable from every channel as documented. ST-303.
- `GET /api/imports/students` never returned a `next_cursor`: it fetched one row past the page and
  then compared the row count against that same inflated limit. It now pages. ST-299.
