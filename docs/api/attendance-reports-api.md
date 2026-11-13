# Attendance reports API

Attendance reports are tenant-scoped analytical views over finalized attendance. They preserve the
normalized attendance model: class and date come from `attendance_sessions`; report queries do not
expect those fields on `attendance_records`.

## Authorization

All routes require a bearer token. `ORG_ADMIN` and `SUPER_ADMIN` receive the dedicated
`ATTENDANCE_REPORT_READ` and `ATTENDANCE_REPORT_EXPORT` permissions. Other roles receive the
standard RFC 9457 `403` response.

Export status is requester-only. A job requested by another user or school is deliberately returned
as `404`, including when the caller is another administrator.

## Filters and attendance semantics

Every report request must select exactly one period:

- `term_id`; or
- both inclusive `start_date` and `end_date`.

Explicit ranges may cover at most 366 inclusive days. A term resolves to its inclusive dates and
also restricts sessions to classes belonging to that term. `class_id` and `student_id` are optional
additional filters.

Only `submitted` and `locked` sessions are counted. `remote` records are included in the present
count. Present, absent, late, and excused percentages use every counted record as their denominator
and are rounded by PostgreSQL to two decimal places. Empty reports return zeroed overall totals and
no grouped rows or trend buckets.

Responses include the resolved period and a UTC `generated_at` timestamp. Replica-backed responses
are eventually consistent. Grouped rows and populated trend buckets have deterministic ordering.

## Summary

`GET /api/attendance/reports/summary`

Additional query parameters:

- `group_by=class|student` (default `class`)
- `limit` from 1 through 500 (default 100)
- `offset` at least zero (default 0)

Example:

```http
GET /api/attendance/reports/summary?term_id=6a8df258-15fd-4ac8-af36-c934bdde23e7&group_by=class&limit=100&offset=0
Authorization: Bearer <token>
```

The response contains `period`, `totals`, `items`, and pagination metadata. Class rows contain
`class_id` and `class_code`; student rows contain `student_id`, `student_name`, and
`admission_number`.

## Trends

`GET /api/attendance/reports/trends`

Set `interval=day|week|month` (default `day`). Only buckets containing counted records are returned.
Week and month bucket dates are PostgreSQL `date_trunc` starts.

```http
GET /api/attendance/reports/trends?start_date=2026-01-01&end_date=2026-03-31&interval=week
Authorization: Bearer <token>
```

## Asynchronous exports

Submit `POST /api/attendance/reports/export` with the same period/class/student filters plus
`file_format`, `group_by`, and `trend_interval`:

```json
{
  "term_id": "6a8df258-15fd-4ac8-af36-c934bdde23e7",
  "file_format": "xlsx",
  "group_by": "student",
  "trend_interval": "week"
}
```

A successful request returns `202` and a `pending` job. XLSX files contain Metadata, Summary, and
Trends sheets. PDF files contain the same metadata, totals, paginated summary rows, and trend rows.
Artifacts use UTC timestamps and are stored under:

```text
reports/{schoolId}/{jobId}/attendance-summary.{xlsx|pdf}
```

Poll `GET /api/attendance/reports/export/{jobId}`. Pending and processing jobs have null download
fields. Completed jobs include `download_url` and `download_url_expires_at`; the URL expires after
15 minutes. Failed jobs expose only a generic `failure_message`, never the stored diagnostic.

The object is governed by the existing seven-day `reports/` lifecycle. The PostgreSQL job row
remains after object expiry; generating the report again creates a new job.

If the queue or object-storage dependency is unavailable, creation returns an RFC 9457 `503`.
Validation, authentication, authorization, and not-found errors use the same standard problem
format as the rest of the API.
