# Row-scope RLS policies (teacher / parent / student)

Studafy isolates every school-owned row by tenant with the permissive `tenant_isolation` policy
([role model](./role-model.md), [migration 000006](../../db/migrations/000006_create_rls_helper.sql)).
That answers _"which school?"_. ST-085 adds the second boundary the academic tables need — _"which
rows within the school may **this** user see?"_ — as a set of **RESTRICTIVE** `SELECT` policies named
`role_scope_visibility`, installed by
[`db/migrations/000036_add_role_scope_rls_policies.sql`](../../db/migrations/000036_add_role_scope_rls_policies.sql)
(canonical copy in [`db/policies/role_scope_visibility.sql`](../../db/policies/role_scope_visibility.sql)).

A restrictive policy ANDs with the permissive tenant policy, so a row is readable only when **both**
boundaries agree: the school matches `app.school_id`, and the caller's role/relationship grants access.
This is the same pattern already used by
[`evaluation_visibility`](../../db/policies/evaluation_visibility.sql) and
[`notification_user_isolation`](../../db/policies/notification_user_isolation.sql), generalized across
the academic domain.

## Role model

There is no `PARENT` enum role. The four scopes are derived from the database, never from a client
claim:

| Scope       | Derived from                                                                                             | Sees                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Admin**   | `app.user_roles.role IN ('ORG_ADMIN','SUPER_ADMIN')`                                                     | every row in the school (escape hatch)                                                                                 |
| **Teacher** | `app.teachers` row, matched to a class via `classes.lead_teacher_id` **or** `timetable_slots.teacher_id` | their classes and those classes' students, materials, assessments, grades, attendance                                  |
| **Student** | `app.students.user_id`                                                                                   | their own profile, enrollments, submissions, released grades/results, attendance; their classes' materials/assessments |
| **Parent**  | `app.parent_child_links.parent_user_id`                                                                  | the same, for each linked child                                                                                        |

`INSTRUCTOR` and `TEACHING_ASSISTANT` are both "teacher"; `GUEST` and `SUPPORT_AGENT` receive no
academic row scope here (they see nothing beyond what tenant isolation alone allows, i.e. nothing on
these tables unless they also hold one of the scopes above).

## Why one policy per table, with ORed scopes

PostgreSQL ANDs restrictive policies. Three separate policies (teacher / parent / student) would
require a caller to satisfy all three simultaneously, which no real principal does. The scopes are
therefore ORed inside **one** policy per table, with the admin escape hatch first — the shape
`teacher_evaluation_visibility` already uses (`teacher OR evaluator`).

## Why SECURITY DEFINER helpers, and why the policies are `TO studafy_app`

The scope predicates read relationship tables (`classes`, `enrollments`, `parent_child_links`,
`timetable_slots`, `user_roles`, …), and several of those tables **also** carry a
`role_scope_visibility` policy. A `SECURITY INVOKER` lookup would re-enter those policies and recurse.

The migration avoids this the same way `notification_user_isolation` does:

- every helper is **`SECURITY DEFINER` owned by `studafy_admin`**, so its lookups run as
  `studafy_admin`;
- every policy is **`TO studafy_app`**, so it applies only to the runtime role and **never** to
  `studafy_admin`.

Inside a helper, only the permissive `tenant_isolation` policy (`TO PUBLIC`) is in force — which
still scopes every lookup to the current school — while the restrictive `role_scope_visibility`
policies are skipped. `studafy_admin` is `NOBYPASSRLS` and `FORCE ROW LEVEL SECURITY` applies to the
owner too, so the helpers cannot cross a school boundary: every lookup additionally pins
`school_id = current_setting('app.school_id')::uuid`.

## Fail-closed user context

`app.scope_user_id()` reads `app.user_id` with `missing_ok = true` and maps unset/empty to `NULL`
(unlike `app.current_user_id()`, which raises). `app.user_id` is legitimately absent in some
transactions (account activation sets only `school_id` + `request_id`), and a predicate that raised
there would turn a benign userless read into a 500. With `NULL`, every relationship check is `NULL`
(never `true`), so a userless caller simply sees no scoped rows.

## Predicate helpers

| Function                                          | Meaning                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| `app.current_user_is_school_admin()`              | admin escape hatch                                      |
| `app.current_user_teacher_id()`                   | caller's teacher id, or `NULL`                          |
| `app.teaches_class(class_id)`                     | lead teacher or timetable-slot teacher of the class     |
| `app.is_related_to_student(student_id)`           | the student themselves, or a linked parent              |
| `app.is_privileged_over_student(student_id)`      | admin, or teacher of a class the student is enrolled in |
| `app.can_read_student(student_id)`                | privileged **or** related                               |
| `app.can_read_class(class_id)`                    | admin, teacher, enrolled student, or parent of one      |
| `app.teaches_gradebook / _exam / _assignment(id)` | teacher of the record's owning class                    |
| `app.can_read_grade(grade_submission_id)`         | grade row via its (release-gated) submission            |
| `app.can_read_course / _subject(id)`              | referenced by a readable class                          |

## Per-table scoping

| Table                                                                | Predicate                                                                                          | Notes                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `students`                                                           | `can_read_student(id)`                                                                             |                                                               |
| `enrollments`                                                        | admin OR `teaches_class(class_id)` OR `is_related_to_student(student_id)`                          | student/parent see only their own enrollment, not classmates' |
| `classes`                                                            | `can_read_class(id)`                                                                               |                                                               |
| `subjects`, `courses`                                                | `can_read_subject/_course(id)`                                                                     | catalog rows referenced by a readable class                   |
| `materials`, `assignments`, `exams`, `gradebooks`, `timetable_slots` | `can_read_class(class_id)`                                                                         |                                                               |
| `assignment_submissions`                                             | admin OR `teaches_assignment(assignment_id)` OR `is_related_to_student(student_id)`                | a submission is a student's own work — **no** release gate    |
| `exam_results`                                                       | admin OR `teaches_exam(exam_id)` OR (`status = 'published'` AND `is_related_to_student`)           | released-result gate                                          |
| `grade_submissions`                                                  | admin OR `teaches_gradebook(gradebook_id)` OR (`status = 'published'` AND `is_related_to_student`) | released-grade gate                                           |
| `grades`                                                             | `can_read_grade(grade_submission_id)`                                                              | inherits the submission's gate                                |
| `attendance_sessions`                                                | `can_read_class(class_id)`                                                                         | partitioned                                                   |
| `attendance_records`                                                 | `can_read_student(student_id)`                                                                     | partitioned                                                   |

### Release gate

Per the grades workflow, only a `published` grade submission / exam result is visible to students and
parents; teachers and admins see any status. The gate is the `status = 'published' AND
is_related_to_student(...)` branch — the staff branches carry no status condition. Assignment
submissions are deliberately **not** gated: a student always sees the work they authored.

### Partitioned attendance

RLS does not cascade from a partitioned parent to its partitions, and `studafy_app` can name a
partition directly, so `role_scope_visibility` is installed on the parents **and** on every existing
leaf, and `app.create_attendance_partitions` (amended in 000036) installs it on every future monthly
leaf — the same discipline `tenant_isolation` follows in
[000012](../../db/migrations/000012_create_attendance_tables_with_partitioning.sql).

## Deliberate non-goals

- **Writes.** These policies are `FOR SELECT`. Insert/update/delete stay bounded by
  `tenant_isolation`'s `WITH CHECK` plus the application permission matrix; per-role write scoping is a
  separate follow-up.
- **`attendance_session_keys` / `attendance_record_keys`.** The derived, SELECT-only key registries
  are left tenant-scoped (not row-scoped); they are internal conflict-precheck state and are not
  exposed through the API.
- **Teacher over-permission on `attendance_records`.** Records are scoped by
  `can_read_student`, so a teacher may see a shared student's attendance across that student's other
  classes. This favors the high-volume table's index path (`school_id, student_id`) over a per-row
  session→class resolution; tighten to per-session-class if that relaxation becomes unacceptable.

## Writes and `RETURNING`

These policies are `FOR SELECT`, but PostgreSQL also applies a table's `SELECT` policies to the rows
an `INSERT`/`UPDATE ... RETURNING` gives back. So a write that returns the affected row succeeds only
when the writer can also _read_ that row under the scope above. This is the same constraint
`notification_user_isolation` already lives with (it avoids `RETURNING` when writing a notification for
another user).

In practice the writer usually can read the row — an admin (escape hatch), the teacher of the row's
class, or the student writing their own submission all pass. Endpoint authors should keep this in
mind: for a write whose actor cannot read the result (e.g. a system job with no user context, or
creating a student who is not yet enrolled), either perform it under an admin/`studafy_admin` context
or omit `RETURNING` and re-fetch through a path the actor is entitled to. Test fixtures follow the
former rule — the factories that seed scoped tables write as `studafy_admin`.

## Performance

Every predicate resolves through an existing school-leading index (`uq_teachers_school_user`,
`idx_classes_school_lead_teacher_id`, `idx_timetable_slots_school_class_id`, the `enrollments` and
`parent_child_links` primary/secondary keys, `user_roles` PK, `idx_grade_submissions_school_student_id`,
`idx_grades_school_grade_submission_id`). Because a `SECURITY DEFINER` function is not inlined, it
appears in an outer query plan as an opaque boolean filter, so the outer table's own index choice is
unchanged; the policy adds a bounded, index-backed predicate evaluation per candidate row. Coverage
and the ≤10% overhead target are guarded by
[`apps/api/tests/security/row-scope.test.ts`](../../apps/api/tests/security/row-scope.test.ts) (an
`enable_seqscan = off` plan check plus a warmed timing budget) and the standing
[`bun run db:test:rls-coverage`](./rls-policy-coverage.md) audit.
