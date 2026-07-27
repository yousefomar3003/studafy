# Assignments API (ST-103)

Class-scoped coursework: teachers manage assignments for the classes they teach, students read the
ones they are actively enrolled in, and file attachments are served as short-lived pre-signed URLs.

Source: [`apps/api/src/modules/academics/assignments`](../../apps/api/src/modules/academics/assignments).
The generated contract is [`apps/api/openapi.json`](../../apps/api/openapi.json); this document
explains the parts of the behaviour a schema cannot express.

## Endpoints

| Method | Path                                                                   | Permission          |
| ------ | ---------------------------------------------------------------------- | ------------------- |
| GET    | `/api/academics/assignments`                                           | `assignment:read`   |
| POST   | `/api/academics/assignments`                                           | `assignment:create` |
| GET    | `/api/academics/assignments/{assignmentId}`                            | `assignment:read`   |
| PATCH  | `/api/academics/assignments/{assignmentId}`                            | `assignment:update` |
| DELETE | `/api/academics/assignments/{assignmentId}`                            | `assignment:delete` |
| POST   | `/api/academics/assignments/{assignmentId}/attachments/upload-url`     | `assignment:update` |
| POST   | `/api/academics/assignments/{assignmentId}/attachments`                | `assignment:update` |
| DELETE | `/api/academics/assignments/{assignmentId}/attachments/{attachmentId}` | `assignment:update` |

Permissions are applied per method, not per path — students hold `assignment:read`, so a path-wide
gate would wave them through to `POST`. See `permissionByMethod()` in the route file.

## Who can see what

Three layers, and each answers a question the others cannot.

| Layer                                                   | Answers                                              |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `tenant_isolation` (migration `000006`)                 | which school?                                        |
| `role_scope_visibility` on `app.assignments` (`000037`) | which rows in the school? (via `app.can_read_class`) |
| the service's visibility predicate                      | active enrolment only, and no drafts for students    |

The third layer exists because the RLS policy has two deliberate gaps for this use case:

- **`app.can_read_class` accepts any enrolment row, including a withdrawn one.** A student who left
  a class in September would otherwise keep seeing its coursework all year.
- **The policy has no status predicate.** A `draft` — a teacher's unfinished work — would be
  readable by every enrolled student the moment the row existed.

The predicate is layered on top of RLS, not a replacement for it. Remove the policy and the service
still refuses another class's work; remove the service check and the policy still refuses another
school's.

| Caller                                    | Sees                                              |
| ----------------------------------------- | ------------------------------------------------- |
| School admin (`ORG_ADMIN`, `SUPER_ADMIN`) | every assignment in the school, every status      |
| Teacher of the class                      | every assignment for that class, including drafts |
| Actively enrolled student                 | non-draft assignments for that class only         |
| Withdrawn student                         | nothing                                           |
| Any other caller                          | nothing                                           |

"Teacher of the class" means the class's `lead_teacher_id` **or** any teacher holding a timetable
slot for it — that is how a co-teacher or substitute works without a second membership table. It is
`app.teaches_class()`, the same helper the RLS policy calls; the service does not reimplement it.

### 403 vs 404

Managing another teacher's class answers **403** (`ASSIGNMENT_CLASS_FORBIDDEN`) — the caller is
staff and has already passed the permission gate, so "not your class" is more useful than a lie.

Reading an assignment outside the caller's scope answers **404**. A student probing ids must not be
able to distinguish "exists but not yours" from "does not exist".

## Filtering and pagination

`GET /api/academics/assignments` accepts `class_id`, `subject_id`, `status`, `limit`, and `cursor`.

`subject_id` filters through `classes.course_id → courses.subject_id`. There is no `subject_id`
column on `app.assignments`: a class already resolves to a subject, and storing it twice would let
the two disagree. It is projected onto responses and accepted as a filter, never written.

`status` is a **derived** filter, not the `app.assignment_status` enum:

| Value       | Means                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| `upcoming`  | `due_at` is in the future                                                          |
| `past_due`  | `due_at` has passed                                                                |
| `submitted` | the **calling** student has a submission in `submitted`/`late`/`graded`/`returned` |

`submitted` is scoped to the caller's own student row, not "any submission exists" — a teacher
filtering by it would otherwise get every assignment anyone had handed in, which is a different
question.

Pagination is keyset, over `(due_at, id)` descending, and returns `next_cursor` (null on the last
page) rather than a `total`. This differs from the `limit`/`offset` used by sibling academics
endpoints; the id tiebreaker is not optional, because several assignments sharing one Friday
deadline is the normal case and a cursor on `due_at` alone would skip or repeat rows at every page
boundary.

Treat the cursor as opaque. Its encoding is an implementation detail and may change.

## Lifecycle

`app.assignments` models lifecycle as the `draft` → `published` → `closed` → `archived` enum, not a
`published` boolean. Publishing is a `PATCH` that sets `status`, and it additionally requires
`assignment:publish`. Creating directly with `status: "published"` is also a publish and is gated
the same way.

- Publishing stamps `assigned_at`. `ck_assignments_lifecycle` requires a draft to have a null
  `assigned_at` and a non-draft to have one, so publishing and stamping are a single operation.
- **Returning a published assignment to `draft` is rejected with 409.** The constraint would reject
  it anyway; refusing explicitly makes it a named error rather than a constraint violation
  surfacing as a 500.
- `DELETE` removes the assignment when it has no submissions, and **archives it instead when it
  does** — `assignment_submissions` references assignments `ON DELETE RESTRICT`, and student work
  must not be orphaned. Both outcomes answer 204; the audit row records which happened.

## Attachments

The upload is three steps and the file never passes through this API.

```
1. POST .../attachments/upload-url  -> { upload_url, storage_key, expires_at }
2. PUT the file body directly to upload_url        (client -> object storage)
3. POST .../attachments { storage_key, content_type } -> the recorded attachment
```

Step 3 verifies the object exists, copies it from `temp/` to `permanent/`, deletes the staged copy,
and writes the row. It is not a formality: without the existence check a client could confirm
metadata for a key it never wrote, leaving a row that renders as a permanently broken download.

### Key scheme and the tenant boundary

Keys follow [`docs/runbooks/storage-conventions.md`](../runbooks/storage-conventions.md):

```
temp/<schoolId>/<objectId>/<filename>
permanent/<schoolId>/<objectId>/<filename>
```

ST-103 is the first implementation of that scheme — it closes the "Known gaps" section at the foot
of that runbook, which recorded that nothing in the repo generated a pre-signed URL and that the
`temp/` → `permanent/` move did not exist.

The `storage_key` is handed to the client in step 1 and handed back in step 3, which makes it
untrusted input on its return leg no matter that we minted it. It is re-validated by
`assertSchoolOwnedKey()` before anything touches storage: a key belonging to another school, under
the wrong category, or containing a path separator or traversal segment is rejected with **403**,
never 404 — the status code must not tell a prober whether a key exists.

The database enforces the same boundary independently:
`ck_assignment_attachments_storage_key` pins a persisted key to `^permanent/<that row's school_id>/`.
Neither layer is sufficient alone. The application check stops an object being copied into another
school's prefix; the constraint stops a row claiming an object there.

The `objectId` is server-generated. That is what keeps two teachers uploading `notes.pdf` to the
same assignment from colliding, and what stops a caller choosing a key that overwrites an existing
attachment.

### Download URLs

`storage_key` is **never** serialized. Responses carry `download_url` — a pre-signed GET, valid for
`S3_PRESIGN_TTL_SECONDS` (default 900s, bounded to 15–60 minutes) — plus
`download_url_expires_at`. Treat the URL as opaque and do not cache it past its expiry. There is no
raw bucket URL in any payload.

### Deleting

Deleting an attachment removes the row and leaves the stored object for a sweep to reclaim. An
object delete cannot participate in the database transaction, so a rollback after a successful
delete would leave a row pointing at bytes that no longer exist — strictly worse than an orphaned
object, which costs storage and nothing else. The same reasoning applies to the hard-delete path on
an assignment.

## Audit

Every mutation writes an `app.audit_logs` row **inside the mutation's own transaction**, so the two
are atomic in both directions: if the audit write fails the mutation rolls back with it, and if the
mutation fails no audit row survives.

| Operation                         | Action   | Target table             |
| --------------------------------- | -------- | ------------------------ |
| Create assignment                 | `insert` | `assignments`            |
| Update assignment                 | `update` | `assignments`            |
| Delete assignment                 | `delete` | `assignments`            |
| Archive (delete with submissions) | `update` | `assignments`            |
| Confirm attachment                | `insert` | `assignment_attachments` |
| Delete attachment                 | `delete` | `assignment_attachments` |

`school_id`, `actor_id`, and `request_id` are read from PostgreSQL session GUCs set by
`withTenantTx`, never passed as arguments. Update rows carry a real before/after diff.

## Domain events

Emitted to `app.outbox_events` within the same transaction:

- `assignment.published` — on `draft` → `published`, whether via create or update.
- `assignment.deadlineExtended` — when `due_at` moves **later** on an already-published assignment.
  Pulling a deadline forward takes time away rather than granting it, and is deliberately not this
  event.

## Configuration

Object storage is optional. When the `S3_*` variables are absent:

- the routes still register, so the published contract does not depend on a deployment's
  environment;
- the attachment endpoints answer **503** (`STORAGE_NOT_CONFIGURED`);
- assignment reads still succeed, with `download_url` and `download_url_expires_at` as `null`.

| Variable                 | Notes                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| `S3_ENDPOINT`            | Optional. Absent means AWS S3; set it for MinIO or another provider. |
| `S3_REGION`              | Required as a group with the three below.                            |
| `S3_ACCESS_KEY_ID`       |                                                                      |
| `S3_SECRET_ACCESS_KEY`   |                                                                      |
| `S3_APP_FILES_BUCKET`    |                                                                      |
| `S3_PRESIGN_TTL_SECONDS` | Default 900. Bounded to 900–3600.                                    |

The four credential/bucket variables are validated as an all-or-nothing group at startup. A
half-configured client would construct successfully and fail at the first presign, turning a
misconfiguration into a runtime 500 on a user's upload instead of a startup error naming the
missing variable.

## Error codes

| Status | Code                                   | When                                                                            |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`                    | inverted date range, non-positive or over-precise `max_score`, malformed cursor |
| 403    | `ASSIGNMENT_CLASS_FORBIDDEN`           | managing a class the caller does not teach                                      |
| 403    | `STORAGE_KEY_FORBIDDEN`                | a storage key outside the caller's school or category                           |
| 403    | `AUTHZ_FORBIDDEN`                      | publishing without `assignment:publish`                                         |
| 404    | `RESOURCE_NOT_FOUND`                   | no such assignment, or outside the caller's read scope                          |
| 404    | `STORAGE_OBJECT_NOT_FOUND`             | confirming a key that was never uploaded                                        |
| 409    | `ASSIGNMENT_INVALID_STATUS_TRANSITION` | returning a published assignment to `draft`                                     |
| 503    | `STORAGE_NOT_CONFIGURED`               | attachment endpoints on a deployment with no bucket                             |

All failures are RFC 9457 `application/problem+json` with a `request_id` for correlation. The 503 is
not declared in the OpenAPI document: `standardResponses()` only admits the statuses
`errorHandlerMiddleware` maps, and 503 is reserved there for `/readyz` draining, which is a success
shape rather than a problem. It is a deployment-configuration failure, not part of the API contract.
