---
title: "Onboarding guide"
description: "Complete walkthrough of the six-step setup wizard every administrator sees after activating their school."
keywords:
  [
    "setup",
    "wizard",
    "school profile",
    "academic year",
    "grading scheme",
    "timetable",
    "staff invitations",
    "student import",
    "csv",
    "skip",
  ]
order: 1
---

# Onboarding guide

The setup wizard appears after your school account is activated. It walks you
through six steps: school profile, academic year, grading scheme, timetable
periods, staff invitations, and student import.

Nothing here is permanent. Every step can be skipped, and everything you
configure can be changed later from the portal. Skipped steps do not block
anything.

## Before you start

- You need a signed-in account with admin permission (`Organization → manage
settings`). The first admin on the school is the one who activated it.
- You can close the wizard and come back later. Your progress is saved on
  this browser as you go, and finished steps show as completed.
- "Skip for now" moves to the next step. It never deletes a previous step.

## Step 1: School profile

![School profile step](/help-media/screenshots/onboarding-school-profile.png)

These defaults apply across your whole school and can be changed later from
settings. Fields:

| Field                                                            | What it does                                                                                 | Default             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| **Default language**                                             | Interface language for the school (English, Francais, Arabic, Espanol, Portuguese, Deutsch). | English             |
| **Timezone**                                                     | IANA timezone, e.g. `Africa/Casablanca`. Used for scheduling and dates.                      | `Africa/Casablanca` |
| **Invitation expiry (days)**                                     | How long invite links stay valid. 1–365.                                                     | 7                   |
| **Attendance alert threshold (%)**                               | Below this attendance rate, alerts fire. 0–100.                                              | 75                  |
| **Absence alert threshold (%)**                                  | Above this absence rate, alerts fire. 0–100.                                                 | 25                  |
| **Attendance correction window (hours)**                         | How long an attendance record can be corrected. 1–8760.                                      | 48                  |
| **Parents can view their child's resolved discipline incidents** | When on, parents see resolved incidents in their portal. Off by default.                     | Off                 |

Click `Save and continue`, or `Skip for now`.

## Step 2: Academic year

![Academic year step](/help-media/screenshots/onboarding-academic-year.png)

"This becomes your school's current academic year, with one term spanning it."

Fields:

| Field          | What it does                                       |
| -------------- | -------------------------------------------------- |
| **Year code**  | Short unique code, e.g. `2025-2026`.               |
| **Year name**  | Full display name, e.g. `Academic Year 2025/2026`. |
| **Start date** | First day of the year.                             |
| **End date**   | Last day. Must be after the start date.            |

Saving creates the year as **active** and adds a single **Full Year** term over
the same dates. Later steps (grading scheme, timetable) build on that term.

## Step 3: Grading scheme

![Grading scheme step](/help-media/screenshots/onboarding-grading-scheme.png)

Requires the academic year from step 2. If you skipped it, the wizard points
you back.

Fields:

| Field                | What it does                                                     |
| -------------------- | ---------------------------------------------------------------- |
| **Scheme name**      | Display name, e.g. `Standard Scale`.                             |
| **Scheme type**      | `letter`, `percentage`, `gpa`, `numeric`, or `pass_fail`.        |
| **Grade boundaries** | One row per grade: label, min %, max %, and optional GPA points. |

Each scheme type loads a template to start from:

- `letter` / `gpa`: A (90–100), B (80–89), C (70–79), D (60–69), F (0–59), each with GPA points.
- `pass_fail`: Pass (60–100), Fail (0–59).
- `percentage` / `numeric`: a single `Score` row (0–100).

Use `Add boundary` for another row and `Remove` to drop one (at least one row
is required). Saving also records the scheme type on your school settings.

## Step 4: Timetable periods

![Timetable periods step](/help-media/screenshots/onboarding-timetable.png)

"Reserve the weekly structure now — period start and end times can be finalized
once you add classes, teachers, and rooms."

Fields:

| Field               | What it does                                                 | Default           |
| ------------------- | ------------------------------------------------------------ | ----------------- |
| **Timetable name**  | Draft name for the weekly structure, e.g. `Draft Timetable`. | `Draft Timetable` |
| **Periods per day** | Number of slots per day, 1–20.                               | 6                 |
| **School days**     | At least one day from Mon–Sun.                               | Mon–Fri           |

At this stage the wizard only reserves the structure — it creates a draft
timetable version for the term. Clock times, teachers, rooms, and slot
placement are finalised later in the Timetable builder.

## Step 5: Staff invitations

![Staff invitations step](/help-media/screenshots/onboarding-staff.png)

"Invite staff by role. Paste one email per line, or separate them with commas."

For each batch:

| Field      | What it does                                                    |
| ---------- | --------------------------------------------------------------- |
| **Role**   | `Admin`, `Teacher`, or `Teaching assistant`.                    |
| **Emails** | One email per line, or comma-separated. Duplicates are removed. |

Use `Add another role` to send several batches in one go, and `Remove batch` to
drop one. `Send invitations` emails every recipient a personalized invite link.

An invite link is single-use and expires after the school default set in step 1
(7 days). There are no password resets for invitations — see the invitations
article for troubleshooting.

## Step 6: Student import

![Student import step](/help-media/screenshots/onboarding-student-import.png)

"Upload a CSV of students to validate. Nothing is saved until you confirm."

1. `Download template` to get a starter CSV with the expected columns.
2. Upload your file. It is validated in a dry run — **no students are saved.**
3. Review the result: total rows, valid rows, rows with errors. Errors list
   the line, field, and message, and can be downloaded as a report.
4. `Confirm import (N students)` creates the valid students in the background.
5. `Continue` to finish the wizard.

Use `Upload a different file` to start over, or `Skip for now` to import
students later from Admin → Students.

## After the wizard

When every step is passed you see the completion screen. `Go to dashboard`
opens the portal. From there you can:

- Build clock times and assign teachers/rooms in the Timetable builder.
- Send more invitations from Admin → Invitations, with more roles and bulk support.
- Import more students from Admin → Students.
- Change school defaults from Admin → Settings.

## Troubleshooting

**I skipped a step. Can I redo it?** Yes. The wizard resumes on this browser; a
skipped step is not deleted. You can also do the equivalent tasks in the portal
(Settings, Timetable builder, Invitations, Students).

**I closed the browser mid-wizard.** Progress is saved in `localStorage` on
that browser. Return to `/onboarding/setup` and continue where you left off.

**My CSV was rejected.** Check the error report — it lists the line, field,
and a message for every problem row. Fix those rows and re-upload. Invalid
rows are ignored by the confirm step; only valid rows are imported.
