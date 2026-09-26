# Student Import Mapping Guide (ST-299)

The student CSV import used to accept one fixed template. It now accepts a school's own export
(columns in any order, under any names, with title lines above the header) by mapping those
columns onto Studafy's import fields. Every line is staged first. An admin reviews a dry-run diff
against live data, and a single transaction then migrates the staged rows into students, parents
and links.

Source:

- [`packages/student-import`](../../packages/student-import): CSV parsing, header detection, the
  mapping engine, row validation and the diff planner. The API and the worker both use it, so the
  preview and the migration classify rows the same way.
- [`apps/api/src/modules/imports`](../../apps/api/src/modules/imports): upload, re-map, diff,
  confirm, and saved-mapping endpoints.
- [`apps/workers/src/queues/imports/worker.ts`](../../apps/workers/src/queues/imports/worker.ts):
  the staging-to-target migration.
- [`db/migrations/000114_add_student_import_mapping_and_staging.sql`](../../db/migrations/000114_add_student_import_mapping_and_staging.sql).

## Lifecycle

```
upload ──► uploaded | validated ──(re-map)──► uploaded | validated
                     │
                     ├── GET diff   (dry run, read-only, as often as needed)
                     │
                     └── confirm ──► confirmed ──(worker)──► processing ──► completed
                                                                  └────────► failed ──(retry)──┘
```

1. **Upload** (`POST /api/imports/students/upload`, `text/csv` body). The CSV is parsed, the header
   row is detected, a mapping is applied (see below), and every data line is written to
   `app.student_import_rows` with its raw cells (`source`) and its mapped, validated record
   (`record`, NULL when the line is invalid). An import is `validated` when every line is valid, and
   `uploaded` otherwise.
2. **Re-map** (`PUT /api/imports/students/{importId}/mapping`). This re-applies a different mapping
   to the staged raw cells and re-validates them, with no re-upload. Pass `save_as` to also save the
   mapping for the school. Only `uploaded` or `validated` imports can be re-mapped (409 otherwise).
3. **Dry-run diff** (`GET /api/imports/students/{importId}/diff`). This shows what migrating would do
   to live data now. See [The diff](#the-diff).
4. **Confirm** (`POST /api/imports/students/{importId}/confirm`). Records `confirmed_by` and queues
   the migration job.
5. **Migrate** (worker). See [Migration guarantees](#migration-guarantees).

All endpoints require `student:import` (ORG_ADMIN, SUPER_ADMIN) on the web channel.

## Fields and targets

| Field                 | Target     | Required | Notes                                                                  |
| --------------------- | ---------- | -------- | ---------------------------------------------------------------------- |
| `admission_number`    | `students` | yes      | Matched case- and whitespace-insensitively.                            |
| `email`               | `students` | yes      | The student's login. An import never changes it.                       |
| `first_name`          | `students` | yes      |                                                                        |
| `last_name`           | `students` | yes      |                                                                        |
| `middle_name`         | `students` | no       |                                                                        |
| `preferred_name`      | `students` | no       |                                                                        |
| `date_of_birth`       | `students` | no       | `YYYY-MM-DD` only; `03/04/2010` is rejected, not guessed.              |
| `status`              | `students` | no       | `applicant`, `enrolled`, … Case-insensitive. New default: `applicant`. |
| `parent_email`        | `parents`  | no       | Finds or creates the parent account (PARENT role).                     |
| `parent_name`         | `parents`  | no       | Display name for a **new** parent only.                                |
| `parent_relationship` | `links`    | no       | `mother`, `step_parent`, …; "Step-Parent" is accepted.                 |

A parent is all or nothing. `parent_email` and `parent_relationship` must be given together, and
`parent_name` needs `parent_email`.

**A blank cell or an unmapped column means "no value", never "clear it".** A create falls back to
the column default. An update leaves the live value unchanged. An import therefore cannot blank out
existing data, and it also cannot deliberately clear a field; use the student profile for that.

## Header detection and mapping

- **Delimiter.** `,`, `;` or tab, whichever occurs most often (outside quotes) on the first
  non-empty line. A leading UTF-8 BOM, as written by Excel, is stripped.
- **Quoting.** RFC 4180 quoting is supported: quoted delimiters, `""` escapes, and line breaks
  inside quotes. Line numbers in errors are physical lines in the file.
- **Header row.** Among the first 10 lines, the header is the one whose cells name the most known
  fields. A tie goes to the earliest line. With no recognisable header at all, line 1 is used and
  mapping validation reports what is unmapped. Lines above the header are ignored.
- **Header text** is compared case-, spacing- and punctuation-insensitively, in any script:
  `Student ID #` and `student id` are the same column. Blank header cells become `Column N`, and
  repeated ones become `Email (2)`.
- **Which mapping applies at upload.** `?mapping_id=<saved mapping>` applies that mapping. Without
  it, a mapping is suggested from the headers. Each field matches its own name (`first_name`,
  `First Name`) and a short alias list, such as `Student ID`, `Surname`, `Given Name`, `DOB`,
  `Guardian Email` and `Relationship`. The full list is in
  [`fields.ts`](../../packages/student-import/src/fields.ts). The fixed template always maps onto
  itself, so existing template uploads behave as before.
- **Mapping validation** (errors reported at `header_line`): every required field must be mapped;
  a mapped header must exist in the file; a column may be mapped to only one field. While the
  mapping is invalid, rows are staged without records and only the mapping errors are reported,
  because per-row errors against a wrong mapping are noise.

The import record returns `header_line`, `source_headers` and the `column_mapping` it was staged
with, so a client can show the detected headers and let the admin correct the mapping.

## Saved mappings

`GET|POST /api/imports/students/mappings`, `PATCH|DELETE /api/imports/students/mappings/{mappingId}`.

- Stored per school in `app.student_import_mappings`. Names are unique per school,
  case-insensitively (409 `IMPORT_MAPPING_NAME_EXISTS`).
- A saved mapping must map every required field (400 `IMPORT_MAPPING_INVALID`). Unknown field keys
  are rejected by request validation.
- An import keeps a **copy** of the mapping it was staged with. Editing or deleting a saved mapping
  never changes an import already staged.

## The diff

Every valid staged row gets exactly one action:

| Action      | Meaning                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `create`    | No student has this admission number: a new student is created, reusing the account for the email if one exists.         |
| `update`    | The student exists, and the row changes at least one field (`changes`, from → to) or creates or changes the parent link. |
| `unchanged` | The student exists, and the row changes nothing.                                                                         |
| `conflict`  | The row cannot be applied safely. It is skipped by the migration and never fails the import.                             |

Conflict reasons:

| `conflict`                           | Why                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `DUPLICATE_ADMISSION_NUMBER_IN_FILE` | An earlier line has the same admission number. The first line wins.      |
| `DUPLICATE_EMAIL_IN_FILE`            | An earlier line gives this email to a different admission number.        |
| `EMAIL_MISMATCH`                     | The student exists but signs in with a different email.                  |
| `EMAIL_BELONGS_TO_OTHER_STUDENT`     | A new admission number whose email is already another student's.         |
| `EMAIL_BELONGS_TO_STAFF`             | The email is a staff account; importing it would grant the STUDENT role. |
| `PARENT_EMAIL_BELONGS_TO_STUDENT`    | The parent email is a student's email, in this file or live.             |

`totals` counts every row. `?action=conflict` (or any other action) filters only the returned rows.
Invalid lines are not in the diff; they are listed in the import's `errors`.

The diff is a preview, not a reservation. The worker recomputes it inside the migration transaction,
so a student edited between the preview and the commit is judged against live data at that moment.

## Migration guarantees

- **Atomic.** One transaction covers the whole import: the plan, every insert and update, every
  audit row, and the `completed` status with its summary. Any error rolls everything back, and the
  import is then marked `failed` in a separate transaction.
- **Idempotent on retry.** Nothing is written outside that transaction, and the plan is rebuilt from
  live data on every attempt. A retry after a failure therefore starts clean. A retry after success
  sees `completed` under the import's row lock and returns the stored summary without writing
  anything. BullMQ retries a job three times with exponential backoff.
- **Serialized.** A row lock on the import stops two workers migrating the same import. A per-school
  advisory lock stops two imports of the same school planning against each other's uncommitted rows.
- **Runs as the system role.** It uses `withSystemTenantTx` (`studafy_admin`, with tenant isolation
  still enforced). The migration cannot run as `studafy_app`: the restrictive
  `role_scope_visibility` policy on `app.students` resolves the acting user, and with none it hides
  every student and rejects `INSERT … RETURNING`. That is why the pre-ST-299 worker failed on the
  first row of every import.

Summary (`student_imports.summary`): `students_created`, `students_updated`, `students_skipped`
(unchanged + conflict), `conflicts`, `parents_created`, `parents_linked`.

## Auditing

Every mutation writes `app.audit_logs` rows in the same transaction as the change:

- **API:** upload (`insert student_imports`, including the mapping used), re-map
  (`update student_imports`, old and new mapping and counts), confirm (`update student_imports`),
  and saved mappings (`insert|update|delete student_import_mappings`).
- **Worker:** every `users`, `user_roles`, `students`, `families` and `parent_child_links` row it
  creates or changes, with `import_id` in `new_values`, plus the `student_imports` completion. The
  actor is the admin who confirmed the import (`app.user_id` is set to `confirmed_by`).

## Limits and known gaps

- 10,000 data rows per upload. Staging writes are batched (2,000 rows per statement).
- The migration writes row by row: up to about eight statements per line, all in one transaction.
  Locally a few thousand rows take seconds. Expect about a minute for 10,000 rows on a
  higher-latency database. If that becomes a problem, the fix is set-based inserts, not splitting
  the transaction.
- Staged rows (`source`, `record`) and `student_imports.errors` hold personal data in jsonb. The
  data-subject erasure pipeline matches personal data by column name, so it does not reach these
  columns. `rows_data` had the same gap. Unconfirmed imports are purged after 48 hours by the
  abandoned-import sweep (its cascade removes their staged rows). Staged rows of confirmed imports
  are kept with the import.
- Imports staged before migration 000114 were backfilled from `rows_data`. Their line numbers are
  positions, not original file lines, because the original lines were never recorded. Their
  `status` was always filled in (`applicant` when absent). For an existing student, the diff can
  therefore show a status change the original file never asked for.
