# Published Grades Read API

ST-116 exposes a student/parent view of the normalized gradebook workflow. Publication remains a
property of `grade_submissions`; individual `grades` rows do not duplicate student, class, term, or
status columns.

## Schema deviation from the ticket

ST-116 specified `student_id`, `class_id`, `assessment_id`, `status`, and `published_at` columns on
`grades`, with partial indexes named `idx_grades_published_lookup` and `idx_grades_class_published`.

That shape is not what was built. Publication is a property of the submission, so it stays on
`grade_submissions`; putting it on `grades` would copy the student, class, term, and lifecycle
columns onto every individual grade row, contradicting the normalization rule the rest of the schema
follows and forcing a second source of truth for status against the existing ST-112/ST-113 entry and
approval flow. The partial indexes carry the same key columns and the same
`WHERE status = 'published'` predicate as specified, but are named for the table they are actually
on:

- `idx_grade_submissions_published_lookup` on `(school_id, student_id, status, published_at DESC)`
- `idx_grade_submissions_gradebook_published` on
  `(school_id, gradebook_id, student_id, published_at DESC)`
- `idx_student_term_summaries`, unique on `(school_id, student_id, academic_term_id)`, as specified

## Endpoint

```http
GET /api/grades/published/students/{studentId}/terms/{termId}
Authorization: Bearer <access-token>
```

The response contains:

- `grades`: published grade records with class/course context, percentages, configured grade labels,
  GPA points when the selected boundary defines them, and the publication timestamp.
- `term_summary`: the course-credit-weighted term percentage and GPA.
- `cumulative_summary`: the credit-weighted GPA through the requested term.

Students may request only their own student ID. Parents may request only students linked to their
user through `parent_child_links`. An unknown or unlinked student identifier returns
`403 ACCESS_DENIED`; an unknown term returns `404 RESOURCE_NOT_FOUND` only after student access has
been established. Administrators and teachers continue to use the gradebook management endpoints.

Only submissions whose stored status is `published` participate. Draft, submitted, approved, and
rejected submissions are excluded explicitly by the query and independently hidden by forced RLS.
Null-score grade rows are omitted and do not contribute to averages.

## Calculation

For each class, grade percentages are weighted by the grade row's `weight`. Class percentages are
then weighted by the owning course's `credit_hours` to produce the term average. Each class
percentage uses the gradebook's linked grading-scheme version, the latest scheme for the term, or
the school's inherited defaults, in that order.

Boundaries are matched by their lower percentage threshold. A term or cumulative GPA is null when
any contributing configured boundary omits `gpa_points`; the percentage and label remain available.
Values are rounded to two decimal places in the API.

`student_term_summaries` is refreshed in the same transaction that publishes a submission. Scores,
scheme links, and course credits that feed a published summary are immutable until a future explicit
republish workflow is introduced.

## Cache and invalidation

Responses are cached for one hour under:

```text
sch:{schoolId}:grades:published:{studentId}:{termId}
```

Authorization is checked against PostgreSQL before cache lookup, so removing a parent-child link
takes effect immediately. Cache writes compare a per-student revision atomically to prevent an
in-flight cache miss from restoring stale data after publication.

The API subscribes to `events:*:grades.published`. When the transactional outbox relay publishes an
event, the subscriber increments the student's revision and removes every indexed term snapshot for
that school and student. Redis failures fail open to the tenant-scoped PostgreSQL read path.

All failures use the RFC 9457 `application/problem+json` contract and include `X-Request-Id`.
