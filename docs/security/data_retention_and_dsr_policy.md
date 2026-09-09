# Data retention & DSR policy (ST-268)

What Studafy keeps, what it erases, and how a GDPR export or erasure request actually runs. The
implementation lives in `apps/workers/src/queues/maintenance` (the export/erasure engine and the
tenant-closure sweep) and `apps/api/src/modules/privacy` (the per-user DSR filing/status API). The
durable record of every request, closure-triggered or filed, is `app.data_subject_requests`
(`db/migrations/000108`).

## Two request shapes, one table, one queue

|              | `subject_scope = 'tenant'`                                                     | `subject_scope = 'user'`                                                              |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Trigger**  | `app.subscriptions.status` reaches `closed` (packages/billing's state machine) | An ORG_ADMIN/SUPER_ADMIN files one, `POST /api/privacy/dsr`, on a subject's behalf    |
| **Filed by** | The daily closure sweep (`closure-sweep.ts`), `reason = 'tenant_closure'`      | The API route, `reason = 'user_request'`                                              |
| **Scope**    | Every discovered tenant table, for the whole school                            | Only rows this pipeline can attribute to that one person (see "Per-user scope" below) |

Both land as the same two BullMQ job types on the `maintenance` queue --
`RUN_DATA_SUBJECT_EXPORT` / `RUN_DATA_SUBJECT_ERASURE` -- and are processed by the same code
(`dsr-processor.ts`). Scope is data, not code: the worker reads `subject_scope`/`subject_user_id`
off the claimed row and behaves accordingly.

## Closure timeline

1. A school's subscription reaches `closed` (grace period exhausted, or any other terminal
   transition the billing state machine allows).
2. The next daily closure sweep (08:30 UTC, `closure-sweep-scheduler.ts`) notices and files a
   **tenant-scope export** request, then enqueues it.
3. `tenant-export.worker.ts` dumps every table `discoverTenantTables` finds for that school --
   structured data as one NDJSON object per table, plus a **files manifest** for
   `materials`/`assignment_attachments`/`submission_attachments` (storage key, original filename,
   checksum -- not the file bytes themselves) -- and a `manifest.json` that
   `export-manifest.ts`'s Zod schema validates before it is ever uploaded. A bundle that fails
   validation is a thrown job error, never a request marked `completed` with an unverified
   manifest -- this is what "schema-verified" means for the acceptance criterion.
4. Once that export is `completed`, a **retention hold** of
   `CLOSURE_ERASURE_RETENTION_HOLD_DAYS` (30 days, `closure-sweep.ts`) elapses before the sweep
   files the matching **tenant-scope erasure** request. This is deliberate breathing room for a
   closure that was a mistake, a billing hiccup, or fraud -- not the same thing as the legal-hold
   classification below, which governs what erasure may never touch regardless of how much time
   has passed.
5. `tenant-erasure.worker.ts` runs the erasure (see "How erasure actually works").

## Per-user DSR (Art. 15 / Art. 17, tenant still active)

`POST /api/privacy/dsr` (`PRIVACY_DSR_MANAGE`, ORG_ADMIN/SUPER_ADMIN only) files a `user`-scope
request with `subject_user_id` and `request_type` (`export` or `erasure`). `GET
/api/privacy/dsr/{requestId}` reports status and, once an export completes, a 15-minute pre-signed
download URL for the manifest.

`sla_due_at` is stamped at filing time, 30 days out -- GDPR Art. 12(3)'s statutory response
deadline. This pipeline's own processing (claim → dump/redact → complete) is expected to finish in
well under that window once claimed; the 30 days is headroom for the organizational side of a DSR
(identity verification, review), not this code's runtime budget.

### Per-user scope

A subject is resolved to `app.users.id` plus, when they have one, `app.students.id` /
`app.teachers.id` (`subject-resolver.ts`) -- most academic records are keyed by the latter two, not
by `user_id`. A table is reachable for a per-user request only if it carries one of `user_id`,
`student_id`, `teacher_id` (`SUBJECT_LINK_COLUMNS`, `retention-registry.ts`), with `app.users`
itself special-cased (matched on its own `id`, since it carries no `user_id` column to match
against).

**Known gap:** a table that identifies a person only by a differently-named column --
`created_by`, `primary_parent_user_id`, `invited_by`, an email address with no `user_id` FK at all
-- is out of this pipeline's reach for a per-user request today. Reaching it needs either renaming
toward the schema's own `user_id`/`student_id`/`teacher_id` convention or widening
`SUBJECT_LINK_COLUMNS` deliberately, table by table, not a blanket heuristic (see
`retention-registry.ts`'s header for why a heuristic is the wrong tool here).

## How erasure actually works

Every tenant foreign key in this schema is `ON DELETE RESTRICT`
(`docs/database/migration-policy.md`; the same fact `infra/tools/tenant-restore`'s README documents
at length for the sibling ST-267 tool). There is no cascade to lean on, and deleting an arbitrary
tenant table's rows in the right cross-table order is exactly the problem that tool had to solve
with a topological sort. This pipeline sidesteps it entirely: **erasure redacts personal-data
columns in place, it does not delete the row**, except for a short, explicit list of pure
session/security artifacts with nothing else worth keeping.

- **`LEGAL_HOLD_TABLES`** (`retention-registry.ts`) -- financial, audit and this pipeline's own
  compliance record (`app.data_subject_requests` itself). Erasure never touches these at all, no
  redaction and no deletion -- GDPR Art. 17(3)(b) exempts data a controller must keep for
  compliance with a legal obligation, and a closed school's ledger and audit trail are exactly
  that. Listed in the completed request's `retained_tables` with a reason.
- **`HARD_DELETE_TABLES`** -- `refresh_tokens`, `user_devices`, `oauth_identities`. Pure
  session/security grants with no other tenant table's foreign key pointing at them and nothing
  non-personal worth retaining once revoked.
- **Everything else** discovered as a tenant table (`tenant-tables.ts`, the exact catalog query
  `infra/tools/tenant-restore/lib/discover-tenant-tables.sql` already treats as ground truth) is
  redacted: every column whose name matches `PII_COLUMN_PATTERNS` (`display_name`, `first_name`,
  `email`, `date_of_birth`, ... -- see `retention-registry.ts` for the full, deliberately
  conservative list) is set to `NULL` if nullable, or to a fresh `'erased-<uuid>'` value if not
  (unique per row by construction, so it can never collide with a `UNIQUE` constraint the way a
  fixed literal would). A table with no matching columns is a reported no-op, not an error --
  erasure runs unconditionally over every discovered table without first asking whether that table
  has anything personal on it.
- `app.schools` itself carries the school's own contact `email`/`normalized_email` and is global
  (no `school_id` column, so `tenant-tables.ts` never discovers it). A **tenant-scope** erasure
  redacts it directly as a final step; a per-user erasure never touches it -- the school's own
  contact identity isn't any one user's personal data.

**Known gap -- `app.teacher_evaluations`:** its `teacher_evaluation_visibility` policy
(`db/migrations/000014`) has no admin escape hatch at all -- a teacher evaluation is visible only
to the evaluator or the person being evaluated, by design. No session identity this pipeline can
produce makes 100% of a school's evaluation rows readable, so both the export and the erasure
passes may miss rows this policy hides from whichever admin they resolved to act as
(`admin-actor.ts`). The export manifest's `knownGaps` field says so explicitly for every bundle
that reaches this table, rather than silently shipping an incomplete one.

## Operational notes

- The tenant-closure sweep is idempotent: it never files a second `tenant`-scope request of a
  given type for a school that already has one, whatever its status
  (`findLatestTenantClosureRequest`). A stuck or failed request needs an operator to look at it,
  not a re-run to paper over it.
- A per-user request is similarly guarded: filing a second request of the same type while one is
  still `queued`/`processing` for that subject returns `409 DSR_ALREADY_PENDING`.
- Redaction requires `app.user_id` to be armed in addition to `app.school_id`
  (`admin-actor.ts`), because several tenant tables layer a `role_scope_visibility` RESTRICTIVE
  policy on top of `tenant_isolation` whose backing functions raise `unrecognized configuration
parameter` the moment it is unset. This pipeline resolves a real ORG_ADMIN (falling back to
  SUPER_ADMIN) of the school and acts as them; a school with no admin at all cannot be swept
  (`NoAdminActorError`, logged, sweep continues with the next school) -- filing a request still
  requires `requested_by_user_id`, and there is no one to attribute it to.
- Export bundles are not purged by any sweep today. A GDPR export bundle is itself personal data,
  so leaving it in object storage indefinitely is its own retention question this ticket did not
  close -- follow-up work, tracked the same way `report-expiry-sweep.ts` closes the equivalent gap
  for ordinary report artifacts.
