# Listing metadata

Source copy for the App Store Connect and Play Console listing forms. Character limits are each
store's hard limit, not a style target — copy below is written to fit, but re-check length before
pasting since both platforms reject over-limit fields outright.

Grounded in what the app actually does today: `apps/mobile/lib/src/features/shell/presentation/shell_destinations.dart`
defines the four role shells (student, teacher, parent, and a read-only "viewer" shell that
super-admin/org-admin/finance/support-agent sessions land on — see `shell_role.dart`), and
`assets/translations/en.json` is the source of truth for in-app copy this listing text should stay
consistent with. Nothing below mentions a price — see `docs/ai_store_compliance.md` for why the AI
add-on specifically must never show one, in-app or in store copy.

## App name

**Studafy** (7 characters). Fits both stores' name field (App Store: 30 chars; Play: 30 chars) with
no truncation risk. Matches `android/app/build.gradle.kts`'s release `app_name` string resource and
`ios/Runner/Info.plist`'s `$(APP_DISPLAY_NAME)`.

## Subtitle (App Store, 30 chars) / short description (Play, 80 chars)

> School, timetable, and grades in one app

29 characters — fits the App Store subtitle field with no room to spare; if it needs to change,
recount it. For Play's 80-character short description, the fuller version fits:

> Timetable, grades, attendance, and school messages for students, parents, and teachers

## Full description (App Store: 4000 chars, no keyword stuffing rule enforced but reviewed; Play: 4000 chars)

One description, used for both stores unless store-specific A/B copy is introduced later. Written
per-role since the app itself branches that way — each paragraph should map to a screenshot set
(see `screenshot-plan.md`).

> Studafy is the mobile companion to your school's Studafy account. Sign in with the invitation
> your school sends you — Studafy accounts are set up by your school, not by signing up in the app.
>
> **For students:** see today's timetable, upcoming assignments and their due dates, new grades,
> attendance, course materials, and exam schedules — all pulled live from your school's Studafy
> account, and still readable offline from the last time you opened the app.
>
> **For teachers:** take attendance, enter grades, post class announcements, upload materials, and
> file incident reports for your classes, from your phone.
>
> **For parents:** follow each of your children's timetable, grades, attendance, and school
> messages in one place, with attendance-alert notifications when a threshold you set is crossed.
>
> **AI study tools (student accounts):** ask questions grounded in your own class materials,
> generate practice quizzes and flashcards, and get summaries and key concepts — an optional add-on
> billed and managed on studafy's website, not in this app.
>
> Studafy requires an active account with a participating school. It is not a public sign-up app.

Length: ~1,050 characters — well inside both stores' 4,000-character limit, leaving room to add a
release-specific paragraph later without restructuring.

## Keywords (App Store keyword field, 100 chars, comma-separated, no spaces after commas)

> school,student,timetable,grades,attendance,parent,teacher,classroom,assignments,gradebook

99 characters. Play has no separate keyword field — its search indexing runs off the title and
description above, so nothing further is needed there.

## Category

- **App Store:** Education (primary). No secondary category needed — the app has no distinct
  second use case (e.g., no games, no standalone productivity tool).
- **Play Console:** Education.

## Age rating / content rating

Recommend **4+ (App Store) / Everyone (Play, PEGI 3)** and **not** enrolled in Apple's Kids
Category or Google Play's Designed for Families program — same positioning as comparable
school-management apps (Google Classroom, Seesaw): accounts are provisioned by the school
(`apps/api/src/modules/auth/invitation`), not created by a child signing up directly, there are no
ads, no in-app purchases, and no open social features (parent "Messages"/"Alerts" in
`parent_communication_screen.dart` are one-directional school-to-parent, not peer messaging).

This is a policy call with legal/compliance weight (COPPA in the US, and each store's own kids-app
rules), not something to finalize from reading the code alone — confirm with whoever owns
compliance sign-off before submitting Play's Data Safety / content rating questionnaire or Apple's
age-rating questionnaire, both of which ask this directly.

## URLs

| Field                 | Value                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| Support URL             | `https://studafy.com/support` — confirm this path exists before submission; not verified as part of this ticket. |
| Marketing URL (optional) | `https://studafy.com`                                                |
| Privacy policy URL      | `https://studafy.com/privacy` (`PrivacyPolicyPage.tsx`) — a working draft, legal-reviewed sign-off still recommended before relying on it as final; see `review-checklist.md`. |
| Account deletion URL (Play Data Safety) | `https://studafy.com/legal/delete-account` — public, no sign-in required. |

## Localization

The app ships `en` and `ar` translations (`assets/translations/`). Both stores support localized
listings — App Store Connect and Play Console each let you add an `ar` (Arabic) listing alongside
`en-US`. Translate this file's copy into Arabic for that listing when it's ready; matching the
in-app translations' tone (`assets/translations/ar.json`) rather than a fresh translation keeps the
listing and the app consistent.
