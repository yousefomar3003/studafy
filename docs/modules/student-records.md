# Student and parent records

Every school asks for different information about a student and their parents: a birth certificate,
a vaccination record, a previous school's report, medical notes, emergency contacts, a bus stop, a
national ID or passport number. Studafy does not hard-code any of it. Each school builds its own
**record templates** (one for students, one for parents), and school leadership fills in the records.
Parents enter nothing.

Studafy itself never asks for government ID. A school may collect it, and Studafy then handles it as
**sensitive** data. Studafy never uses record data, or any email, phone or name, to find, match,
dedupe or link people. Parent-child links are made only by staff choosing both people (see
[finance-module-guide.md "How parents and children get linked"](finance-module-guide.md#how-parents-and-children-get-linked)).

| Piece             | Where                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Data model        | `db/migrations/000169_create_student_and_parent_records.sql`                                                |
| Encryption design | [ADR-019](../adr/0019-sensitive-record-field-encryption.md)                                                 |
| Shared logic      | `packages/records` (field vocabulary, value validation, masking, sealing)                                   |
| API               | `apps/api/src/modules/records` (templates, records, documents, missing information)                         |
| Workers           | `apps/workers/src/queues/maintenance/record-*.ts`, `records-dsr.ts`; `queues/imports`                       |
| Web               | `apps/web/src/features/records` (panel, template editor, missing list), admin + principal                   |
| User guide        | [help/getting-started/student-and-parent-records.md](../help/getting-started/student-and-parent-records.md) |

## What schools can collect

A template is a list of fields. Each field has:

- a **type**: `short_text`, `long_text`, `number`, `date`, `single_choice`, `multi_choice`,
  `yes_no`, `phone`, `email` or `document` (an uploaded file, optionally with an expiry date);
- an English and an Arabic label, optional help text, choice options, an order, and a **required**
  flag;
- a **visibility**: `staff_only`, `finance`, `teachers` or `parent` (see "Who sees what");
- a **sensitivity**: `standard` or `sensitive`; a sensitive field can also carry its own retention
  period.

**Versions.** Template edits are a draft. **Publish** snapshots the draft's live fields as the next
version (`app.record_template_versions`, `app.record_field_versions`). Every answer points at the
field version it was given under, so changing a label, a choice or the required flag never rewrites
an old answer. The record view shows "answered under an earlier version" with the field as it read
then.

**Nothing collected is deleted by a template edit.** Archiving a field drops it from the next
version and keeps its answers. Leadership still sees them, read-only, in an "archived" section.
Only the retention job, a DSR erasure, or deleting the person removes answers.

**Locks.** A published field's type cannot change; archive it and add a new one. A field published
as sensitive stays sensitive. Raising a field to sensitive encrypts its existing answers in the
publish transaction.

**Missing information never blocks anything.** A record is always saveable, and creating,
enrolling and billing a student never wait on a required field or document.

## Who sees what

Row scope comes from the database. The new tables reuse the existing predicates: a student's answers
follow `app.can_read_student` (leadership, a teacher of the student, the student's linked parents),
and a parent's answers are leadership-only. Field scope comes from the API. Visibility is a widening
ladder, `staff_only` < `finance` < `teachers` < `parent`, and a sensitive field is read by leadership
only, whatever its visibility.

| Role                 | Templates | Reads                                                                 | Writes | Sensitive values                          |
| -------------------- | --------- | --------------------------------------------------------------------- | ------ | ----------------------------------------- |
| ORG_ADMIN, PRINCIPAL | build     | every field, every student and parent                                 | yes    | masked; full value via the audited reveal |
| FINANCE              | —         | `finance`, `teachers` and `parent` fields of every student and parent | no     | never                                     |
| INSTRUCTOR           | —         | `teachers` and `parent` fields of students they teach                 | no     | never                                     |
| PARENT               | —         | `parent` fields of their own linked children (not their own record)   | no     | never                                     |

The permissions are `recordTemplate:manage`, `studentRecord:read`, `studentRecord:update` and
`studentRecord:readSensitive` (`packages/constants/src/permissions.ts`). A PRINCIPAL holds all four
but still has no `student:create` / `user:create`: they work on records of people who already
exist. FINANCE reads through the identity transaction (studafy_admin with tenant isolation armed), as
Finance > Unlinked does, because FINANCE cannot read `app.students`.

## How sensitive data is handled

The design is in [ADR-019](../adr/0019-sensitive-record-field-encryption.md):

- **Encrypted at rest.** AES-256-GCM in the application, with the row's identity as additional
  authenticated data, sealed under a versioned keyring (`RECORDS_ENCRYPTION_KEYS`,
  `RECORDS_ENCRYPTION_CURRENT_KEY_ID`). The plaintext column is NULL for every sensitive answer.
- **Masked by default.** Every response returns the mask stored at write time: `•••• 1234` for an
  ID-like value of 8 characters or more, `••••` for anything else. Ordinary reads never decrypt.
- **Revealed only on request.** `POST .../records/{fieldId}/reveal` needs
  `studentRecord:readSensitive` and writes a `read` audit row naming the actor, the time, the field
  and the person, never the value. The web holds a revealed value in component state only and masks
  it again after 30 seconds.
- **Sensitive documents** are stored under the stricter `record.sensitiveDocument` content class
  (PDF/JPEG/PNG, 5 MiB), re-encrypted with a dedicated KMS key when promoted to `permanent/`, and
  downloaded through one-minute URLs that need the reveal permission and are audited like a reveal.
  Ordinary documents use `record.document` (PDF/JPEG/PNG/HEIC, 10 MiB) and five-minute URLs.
- **Audit rows never carry a sensitive value.** A write of a sensitive field records which field
  changed. A standard field's audit row carries the old and new values like any other audited write.
- **Key rotation.** Add a key, point `RECORDS_ENCRYPTION_CURRENT_KEY_ID` at it, and the daily
  maintenance job re-seals every value still under an older key (`record-key-rotation.ts`). Remove
  the old key only after that has run.

### Where record data never goes

Sensitive values never appear in search (`modules/search`), list endpoints, CSV and report exports,
notifications, emails, logs and error messages, analytics, Sentry, the AI module, or the mobile
offline cache:

- None of those modules read the record tables. `apps/api/tests/records/record-data-boundary.test.ts`
  fails if search, AI, notifications, announcements, reports, mobile, messaging, finance, email,
  analytics or the matching worker queues ever name a record table, the sealed column, or the
  records package.
- The missing-information list returns field labels only, never a value.
- Value errors name the field and the rule, never the value, so a rejected passport number cannot
  reach a log or a Sentry event through an error message.
- Decrypted values live inside `SensitiveValue`, which serializes as its mask, so an accidental log
  line or `JSON.stringify` prints `••••`. The Sentry scrubbers (`packages/observability`,
  `apps/web/src/lib/monitoring`) also redact `answer`, `reveal`, `passport`, `medical` and
  `ciphertext` keys.
- Every record response is sent with `Cache-Control: no-store`.

## Retention

A sensitive answer is deleted **12 months after the person leaves** unless the school sets its own
period on the field (1–120 months). For a student, "leaves" means moving to `graduated`, `withdrawn`
or `archived`; `app.students.left_at` is kept by a trigger. For a parent, it means the last of their
linked children has left; a parent linked to no child is never swept.

Why 12 months: it covers the year in which a school is still asked for a leaver's transfer
paperwork, re-enrolments and fee disputes. Past that, identity and medical data about a former
pupil serve no purpose the school's ordinary records do not. This is GDPR's storage-limitation
principle (art. 5(1)(e)).

The sweep (`PURGE_EXPIRED_SENSITIVE_RECORDS`, daily at 08:50 UTC on the maintenance queue) deletes
the answers and their documents, audits each deletion by field id, and deletes the stored files once
its batch has committed. Standard answers stay with the school's ordinary records.

## DSR export and erasure

The GDPR pipeline handles record tables itself (`records-dsr.ts`), because the generic table walk
would export ciphertext and miss parent records:

- **Export** includes every answer about the subject, as a student and as a parent. Sensitive values
  are decrypted so the subject gets their own data (GDPR art. 15), each labelled with the field as it
  read when answered, with document metadata and file keys in the manifest
  (`data/record_answers.ndjson`).
- **Erasure** deletes the subject's answers outright, with their documents cascading. The stored
  files are deleted after the erasure commits. Audit rows stay under the audit legal hold and never
  contain a sensitive value.

## CSV import

The published student template's fields are importable columns next to the fixed ones: in the
mapping step (suggested by English or Arabic label), in saved mappings (`column_mapping.records`), in
the preview, and in the worker's apply.

- A **document field cannot be imported**; its files are uploaded on the Records tab.
- An empty cell never clears an answer already on file. A bad cell fails its row with the field and
  the rule, never the cell.
- **Sensitive columns** are masked in the preview, sealed by the worker, and never written to the
  import's errors, summary or audit rows. An applied import's staged rows (the uploaded cells) are
  deleted in the apply transaction. An unconfirmed import is deleted after 48 hours, and a failed
  import's staged rows are deleted after the same window.
- **Parents are never matched by email.** A `parent_email` that already belongs to an account in the
  school is a `PARENT_ACCOUNT_EXISTS` parent conflict: the student is still imported, with no link,
  and the preview tells staff to link the parent from the student's Guardians tab or Finance >
  Unlinked. A new `parent_email` creates a new parent and household. Rows in the same file sharing
  one new `parent_email` are siblings: the first creates the parent, the others join it, and the
  preview shows that grouping (`parent: "sibling"`, `parent_group_line`) before confirm.

## API

All under the "Student and parent records" tag in `apps/api/openapi.json`:

| Endpoint                                                                                   | Needs                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `GET/POST/PATCH/PUT /api/record-templates/{subjectKind}[/fields…, /field-order, /publish]` | `recordTemplate:manage`                                     |
| `GET /api/record-forms/{subjectKind}` (the published form, for create screens)             | `studentRecord:update`                                      |
| `GET /api/students/{id}/records`, `GET /api/parents/{id}/records`                          | `studentRecord:read`                                        |
| `PUT …/records`, `PUT/PATCH/DELETE …/records/{fieldId}/document`                           | `studentRecord:update`                                      |
| `POST …/records/{fieldId}/reveal`                                                          | `studentRecord:readSensitive`                               |
| `GET …/records/{fieldId}/document/download`                                                | `studentRecord:read` (+ readSensitive for a sensitive file) |
| `GET /api/records/missing/{students,parents,summary}`                                      | `studentRecord:read`                                        |
| `records` on `POST /api/students` and `POST /api/users` (PARENT)                           | + `studentRecord:update`                                    |

Writes are web-only; reads also serve the mobile app.
