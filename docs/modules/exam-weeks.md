# Exam weeks

A school's exam periods — first-term midterms, finals, monthly or mock rounds — planned the way
schools in Jordan and the region run them: an exam timetable per grade, the rooms each exam sits in
(often a hall shared by two grades), every student's seat number, and who invigilates each room.
Leadership builds it on the web and prints seating lists and door sheets; once a period is
published, students and parents see the student's exams with room and seat in the app, and
teachers see their invigilation duties.

- Plan: [`docs/plans/academic-phase2.md`](../plans/academic-phase2.md), WS-M
- Migration: `db/migrations/000266_create_exam_weeks.sql`
- Rules (pure, unit-tested): `apps/api/src/modules/exam-weeks/seating.ts` (`generateSeating`,
  `orderCandidates`, `planSeatMove`) and `clashes.ts` (`detectExamClashes`)
- API: `apps/api/src/modules/exam-weeks` (tag "Exam weeks"); rooms in
  `apps/api/src/modules/academics/routes/room-routes.ts`
- Web: principal portal › Exam weeks (`apps/web/src/features/principal/exam-weeks`, route
  `/portal/principal/exam-weeks`, strings in the `examWeeks` catalog)
- Mobile: `apps/mobile/lib/src/features/exam_weeks` — the exam timetable (student: grades screen
  and Work & grades tab; parent: the child's grades), and the teacher's invigilation duties (home
  card)
- Help: [`docs/help/academics/exam-weeks.md`](../help/academics/exam-weeks.md)

Not to be confused with the online exams of migration 000102 (`app.exams`, `app.exam_sessions`: a
teacher's timed test in the app) or the external exams of 000255 (SAT, IGCSE…). The new tables are
all named `exam_period*`.

The feature is opt-in: a school that adds no exam period sees an empty page and nothing new in the
apps (the app entries appear only once a published period concerns the student or teacher).

## Data model

| Table                           | One row per                                                       |
| ------------------------------- | ----------------------------------------------------------------- |
| `app.exam_periods`              | exam period of an academic year (optionally of a term)            |
| `app.exam_period_grade_levels`  | grade level a period covers                                       |
| `app.exam_period_slots`         | exam: a subject for one grade level, date, start and end time     |
| `app.exam_period_slot_sections` | section that sits an exam                                         |
| `app.exam_period_slot_rooms`    | room an exam sits in, in filling order                            |
| `app.exam_period_seats`         | student's room and seat number in an exam                         |
| `app.exam_period_invigilators`  | teacher invigilating one room of one exam                         |
| `app.rooms.exam_capacity`       | (new column) candidates a room seats in an exam; null: `capacity` |

- **Period**: `name` (unique per year, case-insensitively), `kind` (`midterm`, `final`, `monthly`,
  `mock`, `other`), `starts_on`/`ends_on` (within the academic year, at most 90 days),
  `status` `draft` → `published` (`published_at` set while published).
- **Exam (slot)**: `exam_date` (within the period), `starts_at`/`ends_at` (`time`, the school's wall
  clock; `ends_at > starts_at`), optional `assessment_id` — the gradebook assessment this exam is
  (`app.subject_config_assessments`, same year, same subject and grade). Deleting the assessment
  only clears the link (`ON DELETE SET NULL (assessment_id)`). Sections are pinned to the slot's
  academic year by composite keys; the API also holds them to the slot's grade level.
- **Rooms** are the school's own `app.rooms` (000009), reused rather than duplicated. Leadership can
  now add physical rooms and edit them (`POST /api/academics/rooms`,
  `PATCH /api/academics/rooms/{roomId}`, `timetable:manage`); rooms are deactivated, never deleted.
- **Seats**: one per student per exam, one student per seat number per room per exam. Taking a
  room off an exam deletes its seats and invigilators (cascade); deleting an exam or a period
  deletes everything under it.
- **Invigilators** are teachers (`app.teachers`), so a teacher's duties are found from the session
  (`app.current_user_teacher_id()`).

## Who sits an exam

The students placed in the exam's sections that year (`app.student_sections`), less those exempt
from the subject, and — for an optional or elective subject — only those enrolled in it: the same
rule mark sheets use (`toRoster`). The requirement is the section's override of the subject config,
else the grade default; a subject excluded for a section is sat by nobody in it; a subject with no
grading configuration is treated as taken by everyone. Changing an exam's sections removes the seats
of students who no longer sit it.

## Seating

`generateSeating` seats a slot's candidates into its rooms in their filling order, each room from
seat 1 up to its exam capacity (`exam_capacity`, else `capacity`; a room with neither seats nobody):

| Strategy       | Order                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| `by_section`   | section by section (sections by name, numbers in order), alphabetical inside each   |
| `alphabetical` | everyone by last name, first name                                                   |
| `mixed`        | one student from each section in turn (A1, B1, C1, A2…): neighbours from other ones |

- **Shared rooms**: seat numbers that another exam uses in the same room at an overlapping time are
  skipped, so two grades sharing a hall never share a seat and the hall's capacity holds across both.
- **Stable seat numbers**: regenerating with `keep_existing` (the default) keeps every still-valid
  seat (the student still sits the exam, the room is still the exam's, the seat is within capacity
  and not taken by another exam) and only seats the rest in the free seats. Without it the exam is
  seated afresh. Ties are broken by id, so the same input always gives the same seating.
- Candidates beyond the rooms' capacity stay **unseated** and are listed.
- **Manual adjustment** (`planSeatMove`): a student moves to a free seat of one of the exam's rooms,
  or swaps with the exam's student sitting there. A seat beyond the room's capacity is a 400; a seat
  another exam uses in the room at the same time is a 409.

## Clashes

Worked out on read (`detectExamClashes`), never stored. Two exams are "at the same time" when they
are on the same date and their times overlap (an exam ending at 11:00 does not overlap one starting
at 11:00). Exams of other periods on the period's days are taken into account; only clashes touching
the period are returned.

| Type                    | Severity | Meaning                                                          |
| ----------------------- | -------- | ---------------------------------------------------------------- |
| `teacher_double_booked` | error    | a teacher invigilates two different rooms at once                |
| `student_double_booked` | error    | students who sit two exams at once (one entry per pair, listed)  |
| `room_over_capacity`    | error    | more students seated in a room at its busiest moment than it has |
| `seat_double_booked`    | error    | two exams sharing a room use the same seat number                |
| `room_without_capacity` | warning  | a room of an exam with no exam capacity and no capacity          |
| `insufficient_capacity` | warning  | an exam's rooms cannot seat all its candidates                   |
| `unseated_students`     | warning  | candidates of an exam without a seat                             |
| `no_invigilator`        | warning  | a room with students seated and nobody invigilating it           |
| `on_holiday`            | warning  | an exam on a day of a school holiday (`app.school_events`)       |

One teacher watching a shared hall for two exams is not a clash. Clashes are reported, never
refused: leadership decides.

## Access

| Who                                 | What                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- |
| Leadership (`timetable:manage`)     | everything: periods, exams, rooms, seating, invigilators, clashes, sheets  |
| Whoever may read the student        | `GET /api/academics/students/{studentId}/exam-timetable` (`student:read` + |
| (student, linked parents, teachers) | `app.can_read_student`): published periods only, with room and seat        |
| A teacher                           | `GET /api/academics/me/invigilation-duties`: their own, published only     |

Periods, exams, their sections, rooms and invigilators are the school's timetable, not personal
data: tenant isolation only. A seat says where a student sits, so `app.exam_period_seats` has a
restrictive `role_scope_visibility` policy (`app.can_read_student`). The subjects of exams are read
through `app.exam_period_slot_subjects(uuid[])`, a `SECURITY DEFINER` helper limited to published
periods for students and parents, because `app.subjects` is role-scoped (000037). No existing policy
or function is redefined.

Every write is audited with its old and new values (`exam_periods`, `exam_period_slots`,
`exam_period_seats`, `exam_period_invigilators`, `rooms`).

## Dates and times

Exam dates and times are the school's wall clock, like the weekly timetable. The API returns the
school's timezone (`app.school_settings.timezone`) beside them; the apps show the times exactly as
sent, with "Times are school time (Asia/Amman)", and never convert them to the phone's timezone. The
web formats calendar days in UTC so the day shown is the day stored.

## API

| Method and path                                               | Operation                                      |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `GET`, `POST /api/academics/exam-periods`                     | list (`?academic_year_id`), add                |
| `GET`, `PUT`, `DELETE /api/academics/exam-periods/{periodId}` | read with exams, edit/publish, delete          |
| `POST /api/academics/exam-periods/{periodId}/slots`           | add an exam                                    |
| `GET /api/academics/exam-periods/{periodId}/seating`          | every exam's seats and unseated candidates     |
| `GET /api/academics/exam-periods/{periodId}/clashes`          | clashes                                        |
| `PUT`, `DELETE /api/academics/exam-slots/{slotId}`            | edit, delete an exam                           |
| `POST /api/academics/exam-slots/{slotId}/seating`             | generate seating (`strategy`, `keep_existing`) |
| `PUT /api/academics/exam-slots/{slotId}/seats/{studentId}`    | move or swap a seat                            |
| `PUT /api/academics/exam-slots/{slotId}/invigilators`         | set invigilators per room                      |
| `GET /api/academics/students/{studentId}/exam-timetable`      | a student's timetable                          |
| `GET /api/academics/me/invigilation-duties`                   | the teacher's duties                           |
| `POST /api/academics/rooms`, `PATCH .../rooms/{roomId}`       | add, edit a room                               |

Response schemas are flat (no `allOf`, nullable references each have their own named schema) so the
mobile client generator compiles them.

## Printing

The web's "Print seating lists" prints one page per exam: its candidates by name with room and seat
(unseated ones marked). "Print door sheets" prints one page per room per sitting — every exam in the
room at overlapping times on one sheet — with seats in order, the exams and the invigilators. Only
the sheets print, never the portal around them.

## Tests

- Seating and clashes: `apps/api/src/modules/exam-weeks/seating.test.ts`, `clashes.test.ts`.
- API against a migrated database with RLS: `__tests__/exam-weeks.integration.test.ts` — rooms,
  periods, who sits, seating (stable, shared rooms), moves and swaps, invigilators and clashes,
  drafts hidden, a student and a parent seeing only their own child, a teacher's duties, another
  school seeing and changing nothing, cascades and audit rows.
- Route coverage: audit, permission guard, OpenAPI document and benchmark lists; horizontal authz
  covers the student timetable.
- Web: `ExamWeeksPage.test.tsx`, `print.test.ts`. Mobile: `test/features/exam_weeks`.

Out of scope: notifications (e.g. "your exam timetable is out").
