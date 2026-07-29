# Attendance Correction API (ST-109)

Amending attendance after the register has been submitted, with the original state preserved.

Attendance is otherwise insert-only: `POST /api/attendance/records/batch` writes a class roster and
nothing in the API ever updates those rows. Once a session moves `open → submitted → locked` a
mistyped status is permanent. These two endpoints are the escape hatch — a teacher fixes a recent
mistake, a principal fixes an older one, and every amendment leaves a record of who changed what,
when, and why.

Source: [`apps/api/src/modules/attendance/corrections`](../../apps/api/src/modules/attendance/corrections).
The generated contract is [`apps/api/openapi.json`](../../apps/api/openapi.json); this document
explains the parts of the behaviour a schema cannot express. For the underlying tables see
[attendance-data-model.md](./attendance-data-model.md).

## Endpoints

| Method | Path                                         | Permission                  |
| ------ | -------------------------------------------- | --------------------------- |
| PATCH  | `/api/attendance/records/{recordId}`         | `attendance:record:correct` |
| GET    | `/api/attendance/records/{recordId}/history` | `attendance:record:read`    |

Correcting past the school's window additionally requires `attendance:correction:override`.

| Permission                       | `ORG_ADMIN` / `SUPER_ADMIN` | `INSTRUCTOR` | `TEACHING_ASSISTANT` |
| -------------------------------- | --------------------------- | ------------ | -------------------- |
| `attendance:record:read`         | yes                         | yes          | yes                  |
| `attendance:record:correct`      | yes                         | yes          | no                   |
| `attendance:correction:override` | yes                         | **no**       | no                   |

The role names in the ticket map onto the platform's fixed role set (ADR 0002): _Teacher_ is
`INSTRUCTOR`, _Principal_ is `ORG_ADMIN`.

## Correcting a record

```http
PATCH /api/attendance/records/6f1b0c2e-....
Content-Type: application/json

{
  "status": "excused",
  "reason": "Medical note received after the register closed."
}
```

```json
{
  "id": "6f1b0c2e-....",
  "school_id": "...",
  "attendance_session_id": "...",
  "student_id": "...",
  "status": "excused",
  "minutes_late": null,
  "reason": null,
  "recorded_by_user_id": "...",
  "version": 2,
  "out_of_window": false,
  "created_at": "2026-07-28T08:15:00.000Z",
  "updated_at": "2026-07-29T09:02:11.412Z"
}
```

`reason` is mandatory and must be non-empty after trimming (max 500 characters). It lands on the
version chain, not on the record — `reason` in the response above is the record's own optional note
from when attendance was first taken, which a correction does not touch.

`minutes_late` belongs to `status: "late"` and nowhere else. It is required (`>= 1`) when correcting
_to_ `late`, and discarded when correcting _away_ from it, rather than lingering on a status that
cannot express it.

## The correction window

`app.school_settings.attendance_correction_window_hours` (default **48**) is how long after a
session's business date a record stays correctable by its teacher. It is measured from **midnight of
`attendance_sessions.session_date` in the school's own timezone** (`school_settings.timezone`), so
every record in a session shares one deadline — which is what a teacher expects on being told "you
have 48 hours". Anchoring to each row's `created_at` instead would give one session several
deadlines depending on how the roster was submitted.

A school that has never opened its settings page has no settings row at all (the row is created
lazily on first read), so the API applies the same 48-hour default in that case rather than treating
a missing row as an unbounded window.

Read and changed through `GET`/`PATCH /api/schools/current/settings`.

| Caller               | Inside the window | Past the window                                |
| -------------------- | ----------------- | ---------------------------------------------- |
| Teacher of the class | allowed           | **403** `ATTENDANCE_CORRECTION_WINDOW_EXPIRED` |
| Principal            | allowed           | allowed, flagged `out_of_window: true`         |

## Who can correct what

Three independent layers, none of which subsumes the others.

| Layer                                        | Answers                   |
| -------------------------------------------- | ------------------------- |
| `tenant_isolation` (migration `000054`)      | which school?             |
| `role_scope_visibility` (migration `000054`) | which students within it? |
| class-scope assertion (service layer)        | is this caller's class?   |

The service check delegates to the same SECURITY DEFINER helpers the RLS policies call:

- `app.teaches_class(classId)` — the class's `lead_teacher_id`, or a teacher holding a timetable
  slot for it (covers co-teachers and substitutes).
- `app.current_user_is_school_admin()` — `ORG_ADMIN` and `SUPER_ADMIN`.

### 403 vs 404

Both are reachable and they mean different things.

A caller with **no sight of the student** — a teacher unconnected to the class — fails the
`role_scope_visibility` SELECT policy, so the record never resolves and the answer is **404**
`ATTENDANCE_RECORD_NOT_FOUND`. Answering 403 there would confirm the record exists.

A caller who **can read the record but does not own the class** — most concretely the student the
record is about, who is enrolled and can therefore see both the record and its session — gets **403**
`ATTENDANCE_RECORD_FORBIDDEN`. Nothing is leaked, because they could already see it.

## Session state

Corrections apply once a session has been **submitted** or **locked**. A `draft` or `open` session is
still being taken and `POST /api/attendance/records/batch` owns that state; a `cancelled` session has
no attendance worth amending. Anything else answers **409**
`ATTENDANCE_CORRECTION_NOT_CORRECTABLE`.

## The version chain

`app.attendance_records.version` starts at **1** and increments on each correction. Each correction
also appends one row to `app.attendance_record_versions` holding the before/after status pair, the
reason, the acting user, and whether it was an out-of-window override. Record, chain row, and audit
entry are written in a single transaction.

The chain is immutable: `studafy_app` holds `SELECT` and `INSERT` on
`app.attendance_record_versions` and nothing else, so a correction can never rewrite the history of
an earlier one. A `ck_attendance_record_versions_version` CHECK keeps every stored row at version
`>= 2`, and `uq_attendance_record_versions_chain (school_id, attendance_record_id, version)` keeps
two corrections from claiming the same generation.

A correction that would change nothing answers **409** `ATTENDANCE_CORRECTION_NO_CHANGE`. This also
makes a duplicate submission safe: the replay sees the state its predecessor produced and stops
rather than appending an identical generation.

## History

```http
GET /api/attendance/records/6f1b0c2e-..../history
```

```json
{
  "record_id": "6f1b0c2e-....",
  "student_id": "...",
  "attendance_session_id": "...",
  "entries": [
    {
      "version": 1,
      "status": "absent",
      "previous_status": null,
      "minutes_late": null,
      "reason": null,
      "corrected_by_user_id": "teacher-uuid",
      "corrected_at": "2026-07-28T08:15:00.000Z",
      "out_of_window": false
    },
    {
      "version": 2,
      "status": "excused",
      "previous_status": "absent",
      "minutes_late": null,
      "reason": "Medical note received after the register closed.",
      "corrected_by_user_id": "teacher-uuid",
      "corrected_at": "2026-07-29T09:02:11.412Z",
      "out_of_window": false
    }
  ]
}
```

Entries are ascending by version, oldest first.

**Version 1 is synthesized, not stored.** Its status is whatever the earliest correction replaced
(or the record's current status when there are no corrections), its actor is the record's
`recorded_by_user_id`, and its timestamp is the record's `created_at`. Storing it instead would mean
writing a chain row for every student on every roster — turning the batch-record hot path into two
inserts per student to describe something the record already knows.

## Audit

Every correction writes an `app.audit_logs` entry with `action: update`, `target_table:
attendance_records`, and the diff:

| Field        | Contents                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------- |
| `old_values` | `status`, `minutes_late`, `version`                                                      |
| `new_values` | `status`, `minutes_late`, `version`, `reason`, `out_of_window`, `student_id`, `class_id` |

`actor_id` and `request_id` come from the transaction GUCs `withTenantTx` sets, not from arguments.

## Error codes

| Code                                    | Status | Cause                                                      |
| --------------------------------------- | ------ | ---------------------------------------------------------- |
| `VALIDATION_FAILED`                     | 400    | Missing/invalid `reason`, or `late` with no `minutes_late` |
| `ATTENDANCE_CORRECTION_WINDOW_EXPIRED`  | 403    | Teacher correcting past the school's window                |
| `ATTENDANCE_RECORD_FORBIDDEN`           | 403    | Caller can read the record but does not own the class      |
| `ATTENDANCE_RECORD_NOT_FOUND`           | 404    | No such record, or none the caller may see                 |
| `ATTENDANCE_CORRECTION_NOT_CORRECTABLE` | 409    | Session is not `submitted` or `locked`                     |
| `ATTENDANCE_CORRECTION_NO_CHANGE`       | 409    | Correction matches the current state                       |

All errors are `application/problem+json` (RFC 9457) carrying `code`, `request_id`, and a localized
`detail` (`en`/`ar`).

## Schema notes

`app.attendance_records` is monthly RANGE-partitioned on `created_at` with primary key
`(id, created_at)`, so `id` alone is not unique. Migration `000054` adds
`uq_attendance_records_id_school_created (id, school_id, created_at)` for two reasons: it is the
foreign-key target the chain references, and — leading with `id` — it is the only index that lets a
correction find one record across every partition.

`app.attendance_record_versions` is deliberately **not** partitioned. Corrections are rare relative
to records, and staying unpartitioned keeps `app.create_attendance_partitions` unchanged rather than
requiring a third forward amendment to install `role_scope_visibility` on every future monthly leaf.

It carries `student_id` even though that is reachable through `attendance_record_id`, because the
`role_scope_visibility` policy must call `app.can_read_student()` and a policy expression cannot
cheaply join to a partitioned table. This is the same structural duplication `000012` accepts for
`attendance_records.session_created_at`, for the same reason.
