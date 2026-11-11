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
- [`db/migrations/000179_keep_student_import_sources.sql`](../../db/migrations/000179_keep_student_import_sources.sql):
  original files, leftover cells, unmapped columns and retention (see
  [Import history and unmapped columns](#import-history-and-unmapped-columns)).

## Lifecycle

```
upload ──► uploaded | validated ──(re-map)──► uploaded | validated
                     │
                     ├── GET diff   (dry run, read-only, as often as needed)
                     │
                     └── confirm ──► confirmed ──(worker)──► processing ──► completed
                                                                  └────────► failed ──(retry)──┘
```

1. **Upload** (`POST /api/imports/students/upload`, `text/csv` body, optional `source_key`). The
   web client first stages the same file through the storage gateway (content class
   `import.source`) and passes its temp key as `source_key`; the import keeps it as its original
   file (see [Import history and unmapped columns](#import-history-and-unmapped-columns)). The CSV is parsed, the header
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

| Field                  | Target      | Required | Notes                                                                       |
| ---------------------- | ----------- | -------- | --------------------------------------------------------------------------- |
| `admission_number`     | `students`  | yes      | Matched case- and whitespace-insensitively.                                 |
| `email`                | `students`  | no       | Optional. Without one the student signs in with their member ID (000141).   |
| `first_name`           | `students`  | yes      |                                                                             |
| `last_name`            | `students`  | yes      |                                                                             |
| `middle_name`          | `students`  | no       |                                                                             |
| `preferred_name`       | `students`  | no       |                                                                             |
| `date_of_birth`        | `students`  | no       | `YYYY-MM-DD` only; `03/04/2010` is rejected, not guessed.                   |
| `status`               | `students`  | no       | `applicant`, `enrolled`, … Case-insensitive; Arabic words (منتظم) accepted. |
| `grade`                | `placement` | no       | Grade name, as in Academics. Places the student (see Placement below).      |
| `section`              | `placement` | no       | Section name in that grade. Optional when the grade has one section.        |
| `family`               | grouping    | no       | The school's own family number. Never stored (see Parents below).           |
| `parent_name`          | `parents`   | no       | Parent 1's name, for a **new** parent.                                      |
| `parent_email`         | `parents`   | no       | Parent 1's email. Optional: without one they sign in with their member ID.  |
| `parent_phone`         | `parents`   | per line | Parent 1's phone. **Required whenever the line names parent 1.**            |
| `parent_relationship`  | `links`     | no       | `mother`, `step_parent`, …; "Step-Parent", أم and أب are accepted.          |
| `parent2_name`         | `parents`   | no       | Parent 2, the same way.                                                     |
| `parent2_email`        | `parents`   | no       |                                                                             |
| `parent2_phone`        | `parents`   | per line | Required whenever the line names parent 2.                                  |
| `parent2_relationship` | `links`     | no       |                                                                             |

Arabic header spellings are recognised too (رقم الطالب, الاسم الأول, الصف, الشعبة, رقم العائلة,
اسم ولي الأمر 1, صلة القرابة 2, …; see `packages/student-import/src/fields.ts`).

A parent is all or nothing: a name or an email (or both), a relationship and a phone number. A
relationship or a phone with neither name nor email is rejected, and so is a parent without a
relationship or without a phone. A family line that leaves its parents blank needs no phone: it
joins the parents another line names.

**Phones** are read as people type them: digits with `+ - ( ) .` and spaces, 6 to 20 digits in all,
Arabic-Indic digits (٠٥٠…) read as 0-9 (`normalizePhoneNumber`, `packages/records/src/values.ts`).
The new parent's phone is saved on their account (`app.users.phone`, 000203), where staff with
`user:read` see it on Users and can correct it. It is contact data only: never used to find, match
or link anyone, and erasure redacts it with the account's other personal columns.

### Parents

- **Never matched.** A parent email that already belongs to an account is a `PARENT_ACCOUNT_EXISTS`
  parent conflict: the student is imported, that parent unlinked, and staff link them by hand.
- **Siblings share parents through `family`.** Every line with the same family number shares its
  parent 1 and its parent 2, each created from the first line of the family that names them. A
  line of the family that leaves the parent blank still joins, with the relationship the naming
  line gave, so the school types each family's parents once. The number is the school's own
  statement that those children are siblings, a link staff chose, not one inferred from names or
  phone numbers. Without a `family` column, lines naming the same new parent email share that
  parent (the original rule), and a parent with neither is new on every line.
- **One email, one account.** A new parent email used by two different families is created for the
  first; the second family's parent is `PARENT_EMAIL_IN_OTHER_FAMILY` (unlinked).
- **No duplicates on re-import.** A student who already has a parent gets none from an import
  (`parent: "kept"`).
- A line's two parents join one household (`app.families`): the first linked parent's.

### Placement

`grade` and `section` name a section of the current academic year: the `active` one, else a
`planned` one (a school importing before term starts). Names match case- and spacing-
insensitively. The student is placed (`app.student_sections`) and enrolled in the section's open
classes, skipping any at capacity, as placing by hand does; a student already in another section of
that year is moved. Nothing is created: an unknown grade or section, a grade with several sections
and no section given, or no academic year is a `placement_conflict`, and the student is imported
unplaced (`NO_ACADEMIC_YEAR`, `GRADE_NOT_FOUND`, `SECTION_NOT_FOUND`, `SECTION_REQUIRED`).

**A blank cell or an unmapped column means "no value", never "clear it".** A create falls back to
the column default. An update leaves the live value unchanged. An import therefore cannot blank out
existing data, and it also cannot deliberately clear a field; use the student profile for that.

## Excel template and Excel upload

- **Template.** `GET /api/imports/students/template?format=xlsx&lang=en|ar` builds a workbook
  (`apps/api/src/modules/imports/template-workbook.ts`, exceljs loaded on first use): a Students
  sheet with only a header row (headers are recognised spellings, so the upload maps itself;
  required columns highlighted, the parents' phone columns included; a note on every column;
  right-to-left in Arabic), the school's
  published student record fields as extra columns, dropdowns for status, relationship and the
  school's grades and sections of the current academic year (from a hidden Lists sheet), text format
  on ID and date columns, and Instructions and Example sheets. Example rows never sit on the Students
  sheet, so a forgotten example is never imported. `format=csv` (the default) is the CSV template.
- **Upload.** The page accepts `.xlsx` as well as `.csv`. An Excel file is turned into CSV **in the
  browser** (`apps/web/src/lib/xlsx.ts`, fflate + DOMParser, loaded only when an Excel file is
  picked) and uploaded exactly as a CSV would be, so the API only ever parses CSV and a hostile
  workbook is unpacked in the uploader's own tab, never on a server. Only the workbook parts the
  reader needs are inflated, and a workbook declaring more than 100 MB uncompressed is refused
  unopened. The Students / الطلاب sheet is read, else the first; dates in date-formatted cells become
  `YYYY-MM-DD`; empty rows are kept so line numbers match Excel's row numbers.

## Import data page and login slips

`/portal/admin/import` is where a school starts: grades and sections, then students and parents
(this import), then teachers, then login slips. `/portal/admin/import/slips` prints one slip per
student, parent or teacher who has not signed in yet: name, class (students) or children (parents),
Studafy ID and a one-time setup code (000184; valid 14 days). They sign in with the ID and code and
must choose their own password. There is deliberately no shared default password: member IDs are
sequential, so a shared password would let anyone open any account not claimed yet.

Codes exist only in the response (the server keeps a hash), so the page says to print before
leaving. Running it again skips people whose code is still unused, so printed slips stay valid; the
"reprint" option re-issues those codes instead (earlier slips stop working), paging by member ID
(`after`/`last`) because re-issued members keep matching. Slips are sorted by class, parents by
their first child, and print three to a row with everything else on the page hidden.

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

| Action      | Meaning                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `create`    | No student has this admission number: a new student is created, reusing the account for the email if one exists. |
| `update`    | The student exists, and the row changes at least one field (`changes`, from → to), links a parent, or places it. |
| `unchanged` | The student exists, and the row changes nothing.                                                                 |
| `conflict`  | The row cannot be applied safely. It is skipped by the migration and never fails the import.                     |

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
(unchanged + conflict), `conflicts`, `parents_created`, `parents_linked`, `parent_conflicts`,
`placed`, `placement_conflicts`, `record_answers`.

## Import history and unmapped columns

Nothing in a school's file is lost. Studafy keeps the original file, lists the columns no field
read, and lets staff map those columns to the school's own student or parent record fields later,
without uploading again. Web: **Admin › Students › Import history**
(`/portal/admin/students/imports`, gated like the import page) and one import's page
(`/portal/admin/students/imports/{importId}`).

### The original file

- **Kept on upload.** The browser stages the file with `POST /api/storage/uploads/request-upload`
  (`content_class: "import.source"`, always `text/csv`, 25 MiB cap, `student:import`), PUTs it to
  the signed URL, then uploads the same bytes to the import with `?source_key=`. The API hashes the
  bytes it parsed and checks them against the staged object's SHA-256 (400
  `STORAGE_CHECKSUM_MISMATCH` otherwise), so the kept file is exactly the one imported. It is then
  charged to the storage quota and promoted to `permanent/` under the sensitive-documents KMS key:
  a school's export can hold ID numbers and medical notes no column of ours reads. The generic
  gateway confirm route refuses the class (`gatewayConfirm: false`). Without object storage
  (request-upload answers 503 `STORAGE_NOT_CONFIGURED`) the import works as before, with no file.
- **On the import:** `source_storage_key`, `source_file_name`, `source_size_bytes`,
  `source_uploaded_at`; removal sets `source_removed_at` and `source_removed_reason` (`deleted`,
  `retention`, `erasure`) and clears the key and size. The API returns these as `source_file` on
  `ImportRecord`, with `stored` and `expires_at`.
- **Download:** `GET /api/imports/students/{importId}/source` returns a one-minute signed URL. Every
  URL issued writes a `read student_imports` audit row (`source_file: true, download: true`).
- **Delete:** `DELETE /api/imports/students/{importId}/source` forgets the file now (audited as
  `delete student_imports`), releases its quota and removes the object after commit. The import,
  its summary and its leftover cells stay.
- **History:** `GET /api/imports/students` (already existed; nothing called it) is the history list,
  newest first. Its items (`ImportListItem`) add `uploaded_by_name`, `confirmed_by_name`,
  `unmapped_column_count` and `cells_available`.

### Leftover cells

When the worker completes an import it no longer deletes every staged row. It keeps, in
`app.student_import_rows`, only:

- the lines whose student this run **created or updated** (`student_id`), each also tagged with
  the parent this run created for it, if any (`parent_user_id`; sibling lines share their one new
  parent); lines skipped as `conflict` or `unchanged` wrote no one and are deleted;
- on those lines, only the **non-empty cells of unmapped columns**. Mapped cells already live in
  the records they were written to. `record` is set to NULL.

With no unmapped column, nothing is kept. People are never matched by a name, email, phone or ID
number in the file: these ids are the ones the import itself wrote.

### Unmapped columns

`app.student_import_unmapped_columns` holds each import's unmapped columns (header text and its
normalized form, never a cell), written at upload and replaced on re-map, plus what each was later
applied to. `GET /api/imports/students/{importId}/columns` lists them for any import, with:

- `non_empty_count`, `student_count`, `parent_count`;
- `suggested_field_type`, from the values, computed on the server
  ([`packages/student-import/src/unmapped.ts`](../../packages/student-import/src/unmapped.ts)):
  yes/no, date (only when every value is already `YYYY-MM-DD`: `03/04/2010` is ambiguous and stays
  text), number (never a run of 8+ digits or a leading zero: that is an identifier), phone, email,
  single choice (a few repeated values, matched case-insensitively), else short or long text;
- `suggested_sensitive` and `sensitive_reason`: `label` when the header reads like an ID number,
  passport, medical or pay data (English or Arabic; the records module's hints plus salary, income,
  wage, bank account, IBAN), `values` when every value looks like an ID or passport number. A hint:
  staff decide.
- `can_apply`: the import completed and its leftover cells are still held.

Imported values are never sent to an AI model or any other service to be classified.

### Applying a column

Two calls, so nothing is written without a preview and an explicit confirm:

1. `POST /api/imports/students/{importId}/columns/preview` with `position`, `subject_kind`
   (`student`: the students this import created or updated; `parent`: the parents it created),
   either `field_id` (a published, non-document field) or `new_field` (`label_en`, `label_ar`,
   `field_type`, `options`, `sensitivity`, `visibility`), and `overwrite` (default false). The
   response lists, per person, `write`, `unchanged`, `kept` (has a different answer and overwrite is
   off), `invalid` (with the rule broken, never the value) or `conflict` (a parent's siblings
   disagree), with counts including `empty`. A sensitive target shows masks only. It also returns
   a `preview_token`.
2. `POST /api/imports/students/{importId}/columns/apply` with the same body plus `preview_token`.
   The plan is recomputed under a lock on the import; a different outcome (a field changed, someone's
   answer changed) is refused with 409 `IMPORT_COLUMN_PREVIEW_STALE`. The token hashes the field
   and each person's status, never a value: the cells are immutable once the import completed.
   Values are written with the records module's own `writeAnswers`, one person at a time, so
   validation, sealing of sensitive values (ADR-019), per-answer audit rows and the
   missing-information lists all behave as for a record edit.

Creating a field (`new_field`) also needs `recordTemplate:manage` (403 otherwise). It creates the
field and publishes the template in the same transaction, and is refused with 409
`IMPORT_RECORD_DRAFT_PENDING` while the draft has other unpublished changes: publishing here must
publish this field and nothing else. Both calls also need `studentRecord:update`. 409
`IMPORT_INVALID_STATE` before completion, `IMPORT_CELLS_UNAVAILABLE` once the cells expired, 404
`IMPORT_COLUMN_NOT_FOUND` for a position that is not an unmapped column.

### Retention

The original file and the leftover cells are kept **180 days** from upload by default, and never
longer. A school may shorten it (`GET`/`PUT /api/imports/students/settings`,
`source_retention_days` 1-180, `app.student_import_settings`, audited); the change applies to
imports already held. The daily abandoned-import job also runs
[`import-source-retention-sweep.ts`](../../apps/workers/src/queues/imports/import-source-retention-sweep.ts):
expired files are deleted from storage (after commit) and their quota released, and expired imports'
leftover cells deleted (`cells_purged_at`). Privacy handling (tenant closure, per-person requests) is
in [the DSR policy](../security/data_retention_and_dsr_policy.md#student-import-files).

### Product signal

`GET /api/platform/import-signals/unmapped-headers` (`platform:read`, web console: **Platform ›
Import columns**) counts normalized unmapped header text across schools: header text (its most
common spelling), the number of schools and of imports. No cell value, no school name, and a header
only once at least 3 schools have brought it, so a header one school alone uses (which can say
something about that school) is never shown. Read one school's scope at a time, as every
cross-school platform figure is. Imports uploaded before migration 000179 (or by an instance of the
previous release during a deploy) get their rows from
[`unmapped-columns-backfill.ts`](../../apps/workers/src/queues/imports/unmapped-columns-backfill.ts),
which the daily import job runs: computed from the stored header row and mapping, header text only.
Their original files and leftover cells cannot be recovered: those imports deleted their cells on
completion, and no file was kept.

## Auditing

Every mutation writes `app.audit_logs` rows in the same transaction as the change:

- **API:** upload (`insert student_imports`, including the mapping used and whether the original
  was kept), re-map (`update student_imports`, old and new mapping and counts), confirm
  (`update student_imports`), saved mappings (`insert|update|delete student_import_mappings`),
  original file download (`read student_imports`) and deletion (`delete student_imports`), column
  apply (`update student_import_unmapped_columns`, plus one `record_answers` row per answer and the
  field and template rows when a field is created) and retention (`update student_import_settings`).
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
  columns by itself. `rows_data` had the same gap. Unconfirmed imports are purged after 48 hours by
  the abandoned-import sweep (its cascade removes their staged rows); a failed import's staged rows
  go after the same window. A completed import keeps only its leftover cells, for the retention
  period; erasure handles them explicitly (see the DSR policy).
- Applying a column writes one person at a time through `writeAnswers` (about six statements each),
  inside one request. A few hundred people take well under a second locally; 10,000 can take tens
  of seconds and may meet a proxy timeout. Set-based writes would need a batch variant of
  `writeAnswers` in the records module.
- `student_imports.errors` and `source_headers` are kept for the life of the import, as before.
- Imports staged before migration 000114 were backfilled from `rows_data`. Their line numbers are
  positions, not original file lines, because the original lines were never recorded. Their
  `status` was always filled in (`applicant` when absent). For an existing student, the diff can
  therefore show a status change the original file never asked for.
