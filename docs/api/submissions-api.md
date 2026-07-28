# Submissions API (ST-104)

Student hand-ins and teacher grading: a student has one submission per assignment which
resubmission replaces atomically, work handed in after the deadline is flagged rather than
rejected where policy allows it, and a teacher can mark privately before releasing the score.

Source: [`apps/api/src/modules/academics/submissions`](../../apps/api/src/modules/academics/submissions).
The generated contract is [`apps/api/openapi.json`](../../apps/api/openapi.json); this document
explains the parts of the behaviour a schema cannot express.

## Endpoints

| Method | Path                                                                   | Permission          |
| ------ | ---------------------------------------------------------------------- | ------------------- |
| POST   | `/api/academics/assignments/{assignmentId}/submissions`                | `submission:create` |
| GET    | `/api/academics/assignments/{assignmentId}/submissions`                | `submission:read`   |
| GET    | `/api/academics/submissions/{submissionId}`                            | `submission:read`   |
| PATCH  | `/api/academics/submissions/{submissionId}/grade`                      | `submission:grade`  |
| POST   | `/api/academics/submissions/{submissionId}/attachments/upload-url`     | `submission:update` |
| POST   | `/api/academics/submissions/{submissionId}/attachments`                | `submission:update` |
| DELETE | `/api/academics/submissions/{submissionId}/attachments/{attachmentId}` | `submission:update` |

Permissions are applied per method, not per path — see `permissionByMethod()` in the route file.
Teachers hold `submission:read` but not `submission:create`, and students the reverse, so a
path-wide gate on either would be wrong in one direction.

`submission:update` on the attachment routes is doing real work rather than filling a slot. Only
`STUDENT` and the admin roles hold it; `INSTRUCTOR` and `TEACHING_ASSISTANT` do not. A teacher can
read the files they are marking and cannot add to or remove from them.

The hand-in endpoint answers **201** on a first submission and **200** on a resubmission, so a
client can tell which happened without comparing `attempt_number` against a value it may not have.

## Who can see what

Three layers, and each answers a question the others cannot.

| Layer                                                              | Answers                                  |
| ------------------------------------------------------------------ | ---------------------------------------- |
| `tenant_isolation` (migration `000006`)                            | which school?                            |
| `role_scope_visibility` on `app.assignment_submissions` (`000037`) | _whether the row exists_ for this caller |
| `toSubmissionResponse()` in the route file                         | _which fields of a visible row_ they get |

| Caller                                    | Row             | Released grade | Unreleased grade                 |
| ----------------------------------------- | --------------- | -------------- | -------------------------------- |
| The submitting student                    | visible         | full           | withheld, `grade_status: "none"` |
| Another student, same class               | **not visible** | —              | —                                |
| Teacher of the assignment's class         | visible         | full           | full                             |
| Linked parent (`app.parent_child_links`)  | visible         | full           | withheld, `grade_status: "none"` |
| School admin (`ORG_ADMIN`, `SUPER_ADMIN`) | visible         | full           | full                             |
| Any caller in another tenant              | **not visible** | —              | —                                |

"Teacher of the assignment's class" means the class's `lead_teacher_id` **or** any teacher holding
a timetable slot for it. It is `app.teaches_assignment()`, the same helper the RLS policy calls;
neither the service nor the projection reimplements it, so "staff" has one definition in the system.

Note that `app.teaches_class()` requires the caller to have a row in `app.teachers`. A
`TEACHING_ASSISTANT` holds `submission:grade` but will be refused at the row-scope check unless
they are also modelled as a teacher — that is pre-existing behaviour inherited from `000037`, not
something this API decides.

Parents were granted `submission:read` and `assignment:read` by this ticket. Before it,
`PARENT_PERMISSIONS` was `[STUDENT_READ]` alone, so a linked parent was refused at the permission
gate before RLS was ever consulted. The narrowing to _their own child_ is done by the database:
`app.is_related_to_student` resolves `parent_child_links`, so the permission grants exactly their
child's work and nothing else.

### Grade withholding

> **`score`, `feedback`, `graded_at` and `graded_by_user_id` are `null`, and `grade_status` is
> reported as `"none"`, for any non-staff viewer whenever the stored `grade_status` is not
> `published`.**

`app.exam_results` and `app.grade_submissions` gate the whole row on publication. Submissions
deliberately do not, and the difference is not an oversight: an exam result has no existence for the
student before it is published, whereas a submission **is the student's own work**. Hiding the row
while it is being marked would make their own hand-in vanish from their view.

So withholding here is a _column_ rule, and a column rule cannot live in an RLS policy — RLS filters
rows. It lives at the response projection, the same single function that already drops `storage_key`.

Two details that matter more than they look:

- **`grade_status` is masked, not passed through.** Reporting `draft` to a student would leak
  precisely the fact the nulls exist to hide — that marking has begun. They see `none`, exactly as
  they would for unmarked work.
- **`status` needs no masking, and that is by construction.** `ck_assignment_submissions_lifecycle`
  (`000049`) was written with a branch that permits a score while `status` stays `submitted`, so the
  lifecycle field the student already watches simply does not move until publication.

The service never selects those columns away. It returns the complete row, so audit diffs and event
payloads see the truth and only the wire format is narrowed. `grade-visibility.test.ts` proves the
rule without a database, so the most security-relevant assertion in the module is not one that
silently skips when `TEST_DATABASE_URL` is unset.

### 403 vs 404

Grading a class the caller does not teach answers **403** (`SUBMISSION_FORBIDDEN`) — they are staff
and have already passed the permission gate, so "not your class" is more useful than a lie.

Reading a submission outside the caller's scope answers **404** (`SUBMISSION_NOT_FOUND`). A student
probing ids must not be able to distinguish "exists but not yours" from "does not exist"; that
distinction is the whole of classmate privacy.

Submitting to an unpublished assignment answers **404**, not "window closed", for the same reason —
a window error would confirm that a teacher's draft exists.

## Filtering and pagination

`GET /api/academics/assignments/{assignmentId}/submissions` accepts `limit`, `offset`, `status`,
`grade_status`, and `student_id`.

Limit/offset rather than the keyset cursor the assignments list uses. The difference is the shape of
the set: an assignment list grows without bound and is read continuously while teachers add rows,
which is what makes an offset unsafe there. A submissions list is one assignment's class roster —
bounded, small, and paged through deliberately. That matches every other academics list endpoint.

Two filters are silently narrowed rather than rejected for non-staff callers:

- **`student_id` is ignored.** A student's list is always their own row; honouring the parameter
  would imply it could be something else.
- **`grade_status` is dropped.** A non-staff caller cannot observe the distinction it filters on, so
  honouring it would turn the query into an oracle for the fact the projection hides — ask for
  `grade_status=draft` and a non-empty result tells you marking has begun.

## Lifecycle

Two axes, not one.

`status` (`app.assignment_submission_status`) tracks the hand-in:
`draft → submitted → graded`, with `returned` for work sent back and `withdrawn` for work pulled.

`grade_status` (`app.submission_grade_status`, added by `000049`) tracks the mark:
`none → draft → published`.

They are separate because `status = 'draft'` already meant "the student has not handed in yet".
Overloading it for "the teacher has not released the mark yet" would have made one word mean two
opposite things. `ck_assignment_submissions_lifecycle` ties them together where they must agree:
`status = 'graded'` implies `grade_status = 'published'`, so the two can never disagree.

**`is_late` is orthogonal to both.** `000011` modelled lateness as the enum value `'late'`, which its
lifecycle constraint made mutually exclusive with `'graded'` — so marking a late submission erased
the fact that it was late. `000049` replaced that with a plain boolean nothing in the lifecycle
reads. The `'late'` enum value survives because rows written before that migration carry it and a
PostgreSQL enum value cannot be removed, but **this API never writes it**: a late hand-in is
`submitted` with `is_late: true`.

Lateness is computed by PostgreSQL as `CURRENT_TIMESTAMP > a.due_at`, inside the write. Computing it
in TypeScript would introduce a second clock that can disagree with the one every constraint and
ordering on the row already uses, and the disagreement would be invisible.

### Resubmission

`uq_assignment_submissions_school_assignment_student` permits exactly one row per student per
assignment, so a resubmission is an in-place `UPDATE`, not a new row. It increments
`attempt_number` and clears any unpublished mark — a new attempt invalidates the marking of the old
one.

The whole operation is a single `INSERT ... ON CONFLICT DO UPDATE`. Every gate — publication,
availability window, deadline, the assignment's own late policy, active enrolment — is a predicate
on the `SELECT` feeding the `INSERT`, so a refusal produces zero rows rather than a partial write,
and there is no window between checking and writing in which any of those facts could change.

`ON CONFLICT DO UPDATE` **is** the atomicity. Two concurrent double-taps race for the unique index;
the loser blocks on the index tuple, then resolves to the `DO UPDATE` and reads `attempt_number`
under the row lock conflict resolution is already holding. A read-then-write would lose an
increment, and `SELECT ... FOR UPDATE` cannot help because on a first submission there is no row to
lock. `submissions.test.ts` runs two separate transactions on two connections to prove it.

The mark is cleared in the same statement that moves `submitted_at`, not a following one:
`ck_assignment_submissions_grading_time` requires `graded_at >= submitted_at`, so splitting them
would fire the constraint.

Resubmission is refused over a **published** grade (`SUBMISSION_ALREADY_GRADED`) unless the teacher
has sent the work back with `return_to_student: true`, which also permits it after the deadline.

**Where the replaced work lives:** in `app.audit_logs`. There is no versions table — the update
writes an audit row carrying the superseded `old_values`, which is the history.

## Attachments

Identical three-step flow to the assignments module, for the identical reason — the file never
passes through this API:

```
1. POST .../submissions/{id}/attachments/upload-url  -> pre-signed PUT for temp/<schoolId>/<uuid>/<name>
2. client PUTs the bytes straight to object storage
3. POST .../submissions/{id}/attachments             -> verify, promote to permanent/, persist
```

Step 3 is not a formality: without a server-side existence check a client could confirm metadata for
a key it never wrote, leaving a row that renders as a permanently broken download.

Rows are stamped with the submission's `attempt_number` as it stood when the file was confirmed.
Because resubmission updates the row in place, without that stamp every attempt's files would
collapse into one undifferentiated pile and a teacher could not tell which version they were marking.

### Key scheme and the tenant boundary

`<category>/<schoolId>/<objectId>/<filename>`, per
[`docs/runbooks/storage-conventions.md`](../runbooks/storage-conventions.md). The object id is
server-generated, never client-supplied: it is what keeps two students uploading `essay.pdf` from
colliding, and what stops a caller choosing a key that overwrites somebody else's file.

The storage key is handed to the client in step 1 and handed back in step 3, which makes it
untrusted input on its return leg no matter that we minted it. `assertSchoolOwnedKey` re-derives that
it is a `temp/` key belonging to **this** school before anything touches storage; a substituted key
answers **403** (`STORAGE_KEY_FORBIDDEN`), never 404, so a prober learns nothing about existence.

`ck_submission_attachments_storage_key` (`000049`) is the database half of the same boundary, pinning
a persisted key to `^permanent/<that row's school_id>/`. Neither layer is sufficient alone: the
application check prevents an object being copied into another school's prefix, and this one prevents
a row from claiming an object there.

The storage work happens before the `INSERT` and is not transactional with it. The failure modes are
asymmetric: a rollback after a successful copy leaves an unreferenced object under `permanent/` —
wasted bytes, reclaimable by a sweep — whereas the reverse order would leave a row pointing at an
object that was never promoted, which is a broken download on work the student believes they handed
in.

### Download URLs

`storage_key` is **never** serialized. It reveals the bucket layout, and the layout is guessable
enough that publishing one school's keys would hand a reader the shape of every other school's. A
short-lived pre-signed GET URL is the only handle a client gets.

When object storage is unconfigured, `download_url` and `download_url_expires_at` are `null` and the
read still succeeds. A deployment without a bucket should still be able to list submissions; failing
the whole request over a download link would take out the feature to protect an attachment.

### Deleting

The database row goes; the stored object stays, for a storage sweep to reclaim. Deleting from S3
cannot participate in the transaction, so a rollback after a successful delete would leave a row
pointing at bytes that no longer exist — strictly worse than an orphaned object, which costs storage
and nothing else.

## Audit

| Operation                      | Action   | Target table             |
| ------------------------------ | -------- | ------------------------ |
| First hand-in                  | `insert` | `assignment_submissions` |
| Resubmission                   | `update` | `assignment_submissions` |
| Grade draft / publish / return | `update` | `assignment_submissions` |
| Confirm attachment             | `insert` | `submission_attachments` |
| Delete attachment              | `delete` | `submission_attachments` |

Every row is written by `emitAuditLog` from **inside the service transaction**, so a mutation and its
record commit or roll back together — a refused hand-in leaves no audit row at all.
`school_id`, `actor_id` and `request_id` come from the transaction GUCs that `withTenantTx` sets and
are never passed as arguments.

The `POST` route declares `auditAction("insert", "assignment_submissions")` for the CI coverage gate,
but the service emits the action that actually occurred — `update` for a resubmission.

## Domain events

Written to `app.outbox_events`. All three payloads were already defined in
`packages/constants/src/events.ts`; this ticket added no event schemas.

- `submission.created` — **first hand-in only**, detected via `xmax = 0`. A resubmission is an edit
  of work the rest of the system already knows about, and re-announcing it would have every consumer
  treat it as new.
- `submission.graded` — **publication only**, never a draft save. Announcing a draft would notify a
  student about a grade they cannot see.
- `submission.resubmissionRequested` — when a grade PATCH sets `return_to_student: true`.

## Configuration

| Variable                                                                       | Notes                                                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `S3_APP_FILES_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | All-or-nothing group. Unset ⇒ attachment endpoints answer **503** and download URLs are `null`. |
| `S3_ENDPOINT`                                                                  | Absent means AWS proper; set for MinIO.                                                         |
| `S3_PRESIGN_TTL_SECONDS`                                                       | 900–3600, default 900.                                                                          |

The routes register unconditionally, so the published contract does not depend on a deployment's
environment. An honest 503 is a better failure than a path that exists in one environment and not
another.

## Error codes

| Status | Code                           | When                                                                         |
| ------ | ------------------------------ | ---------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`            | body fails schema validation                                                 |
| 400    | `SUBMISSION_SCORE_EXCEEDS_MAX` | `score` above the assignment's `max_score`                                   |
| 403    | `SUBMISSION_FORBIDDEN`         | grading a class not taught; attaching to another student's submission        |
| 403    | `SUBMISSION_NOT_ENROLLED`      | caller has no `app.students` row, or no active enrolment in the class        |
| 403    | `STORAGE_KEY_FORBIDDEN`        | a storage key belonging to another school or category                        |
| 404    | `RESOURCE_NOT_FOUND`           | no such assignment, or it is still a draft                                   |
| 404    | `SUBMISSION_NOT_FOUND`         | no such submission, or outside the caller's read scope                       |
| 404    | `STORAGE_OBJECT_NOT_FOUND`     | confirming a key that was never uploaded                                     |
| 409    | `SUBMISSION_WINDOW_CLOSED`     | before `available_from`, or past `due_at` with `allow_late_submission` false |
| 409    | `SUBMISSION_ALREADY_GRADED`    | resubmitting over a published grade that was not returned                    |
| 409    | `SUBMISSION_INVALID_STATE`     | grading work never handed in; publishing with no score                       |
| 503    | `STORAGE_NOT_CONFIGURED`       | attachment endpoints on a deployment with no bucket                          |

All errors are RFC 9457 `application/problem+json` and carry the `request_id`.
