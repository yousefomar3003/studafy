# Demo Seed Data

SQL seed scripts that populate a realistic demo school with all roles, academic structure, timetable, grades, invoices, materials, and AI data for local dev/staging.

## Prerequisites

- All migrations applied (`bun run db:migrate`)
- Local PostgreSQL running (`docker compose -f db/compose.yml up -d`)

## Usage

```bash
# Run all seeds
bun run db:seed

# Or via CLI directly
bun packages/db/src/cli.ts seed
```

## Safety

- **Idempotent**: Every INSERT uses `ON CONFLICT DO NOTHING`. Safe to re-run.
- **Production guard**: Refuses to run if `NODE_ENV=production`.
- **Migration check**: Aborts if any pending migrations exist (must apply migrations first).

## Files

| File                          | Description                                               |
| ----------------------------- | --------------------------------------------------------- |
| `001_global_reference.sql`    | Plans + plan_prices (starter, pro)                        |
| `002_school.sql`              | Demo Academy school + subscription                        |
| `003_users_and_roles.sql`     | 13 users across all 7 roles + OAuth mocks                 |
| `004_profiles.sql`            | Teacher profiles (4) + student profiles (5) + parent link |
| `005_academic_structure.sql`  | Academic year, terms, subjects, courses, rooms            |
| `006_classes_enrollments.sql` | 5 classes for Spring 2026 + 20 enrollments                |
| `007_timetable.sql`           | Approved timetable version + 15 time slots                |
| `008_materials.sql`           | 4 materials + 5 material chunks (RAG embeddings)          |
| `009_assessments.sql`         | 4 assignments + 4 submissions                             |
| `010_grades.sql`              | 5 gradebooks + grade submissions + grades                 |
| `011_attendance.sql`          | 3 attendance sessions + records (July 2026)               |
| `012_finance.sql`             | Invoice cache, payment cache, fee schedule cache          |
| `013_ai.sql`                  | AI subscriptions, conversations, messages, usage meters   |
| `014_notifications.sql`       | Notifications + user devices                              |

## Demo Data

### School

- **Demo Academy** (slug: `demo-academy`)
- Plan: Starter, USD currency, US country

### Users

| Role               | Email                              | Notes                   |
| ------------------ | ---------------------------------- | ----------------------- |
| SUPER_ADMIN        | admin@studafy.local                | Platform admin          |
| ORG_ADMIN          | admin@demo-academy.local           | School admin            |
| INSTRUCTOR         | teacher.math@demo-academy.local    | Math teacher            |
| INSTRUCTOR         | teacher.science@demo-academy.local | Science teacher         |
| INSTRUCTOR         | teacher.english@demo-academy.local | English teacher         |
| INSTRUCTOR         | teacher.history@demo-academy.local | History teacher         |
| TEACHING_ASSISTANT | ta@demo-academy.local              | TA                      |
| STUDENT            | student.alice@demo-academy.local   | Alice (ADM-2026-001)    |
| STUDENT            | student.bob@demo-academy.local     | Bob (ADM-2026-002)      |
| STUDENT            | student.carol@demo-academy.local   | Carol (ADM-2026-003)    |
| STUDENT            | student.david@demo-academy.local   | David (ADM-2026-004)    |
| STUDENT            | student.eve@demo-academy.local     | Eve (ADM-2026-005)      |
| PARENT             | parent.frank@demo-academy.local    | Frank (parent of Alice) |
| GUEST              | guest@demo-academy.local           | Guest user              |
| SUPPORT_AGENT      | support@demo-academy.local         | Support agent           |

### Academic

- **Year**: AY-2025-2026
- **Terms**: Fall 2025 (closed), Spring 2026 (active), Summer 2026 (planned)
- **Subjects**: MATH, SCI, ENG, HIST, ART
- **Courses**: 5 courses mapped to subjects
- **Classes**: 5 classes for Spring 2026
- **Enrollments**: 20 total (all 5 students in 3 core, 3 in History, 2 in Art)

### Timetable

- 1 approved version with 15 time slots (Mon-Fri, 3 periods)

### Materials

- 4 materials with storage keys matching `^permanent/<school_id>/[^/]+/[^/]+$`
- 5 material chunks with dummy embeddings for RAG

### Assessments

- 4 assignments (2 Math, 1 Science, 1 English)
- 4 submissions (mix of submitted/graded)

### Grades

- 5 gradebooks (one per class, status active)
- 2 grade submissions (published, submitted)
- 2 grades

### Attendance

- 3 sessions in July 2026 (within partition range)
- Records for enrolled students (present, late, absent)

### Finance

- 1 fee schedule cache (Fall 2026 tuition)
- 3 invoice caches (overdue, partially paid, paid)
- 2 payment caches (partial, full)

### AI

- 5 subscriptions (3 active, 2 trialing)
- 3 conversations
- 3 messages
- 5 usage meters

### Notifications

- 6 notifications (enrollment, assignment due, grade posted, course published, discussion reply)
- 4 devices (iOS, Android, 2x web)
