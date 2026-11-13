# Listing metadata

Source copy for the App Store Connect and Play Console listing forms. Character limits are each
store's hard limit, not a style target — copy below is written to fit, but re-check length before
pasting since both platforms reject over-limit fields outright.

Grounded in what the app actually does today: `apps/mobile/lib/src/features/shell/presentation/shell_destinations.dart`
defines the four role shells (student, teacher, parent, and a read-only "viewer" shell that
super-admin/org-admin/finance/support-agent sessions land on — see `shell_role.dart`), and
`assets/translations/en.json` is the source of truth for in-app copy this listing text should stay
consistent with. Nothing below mentions a price or where the AI add-on is bought — see
`docs/store_payment_routing.md` for why store copy must not steer to an outside purchase either.

## App name

**Studafy** (7 characters). Fits both stores' name field (App Store: 30 chars; Play: 30 chars) with
no truncation risk. Matches `android/app/build.gradle.kts`'s release `app_name` string resource and
`ios/Runner/Info.plist`'s `$(APP_DISPLAY_NAME)`.

## Subtitle (App Store, 30 chars)

> Timetable, grades & attendance

30 characters, exactly the limit. App Store search indexes the app name, subtitle and keyword
field together, so the keywords below don't repeat these three words.

## Short description (Play, 80 chars)

> Timetable, grades, attendance and messages for students, parents and teachers

77 characters.

## Full description (App Store: 4000 chars, no keyword stuffing rule enforced but reviewed; Play: 4000 chars)

One description, used for both stores unless store-specific A/B copy is introduced later. Written
per-role since the app itself branches that way — each paragraph should map to a screenshot set
(see `screenshot-plan.md`).

> Studafy is the mobile companion to your school's Studafy account. Sign in with the invitation
> your school sends you — Studafy accounts are set up by your school, not by signing up in the app.
>
> **For students:** see today's timetable, upcoming assignments and their due dates, new grades,
> attendance, course materials, and exam schedules, all pulled live from your school's Studafy
> account. Your timetable, grades and course materials stay readable offline, as of the last time
> you opened them.
>
> **For teachers:** take attendance, enter grades, post class announcements, upload materials, and
> file incident reports for your classes, from your phone.
>
> **For parents:** follow each of your children's timetable, grades, attendance, and school
> messages in one place, with attendance-alert notifications when a threshold you set is crossed.
>
> **AI study tools (student accounts):** ask questions grounded in your own class materials,
> generate practice quizzes and flashcards, and get summaries and key concepts — available on
> accounts with the AI add-on active.
>
> Studafy requires an active account with a participating school. It is not a public sign-up app.

About 1,100 characters, well inside both stores' 4,000-character limit. Every claim maps to a
shipped screen; the offline sentence is limited to what `docs/offline-strategy.md` actually caches
(timetable, published grades, materials, announcements), not assignments, attendance or exams.

## Keywords (App Store keyword field, 100 chars, comma-separated, no spaces after commas)

> school,student,parent,teacher,classroom,assignments,gradebook,homework,exams,schedule,quiz

90 characters. Each term maps to a shipped screen: assignments and homework
(`AssignmentDetailScreen`), gradebook (`GradeEntryScreen`), exams (`StudentExamsScreen`), schedule
(`TimetableScreen`), quiz (`QuizScreen`, AI add-on). Play has no separate keyword field; its search
indexing runs off the title and description.

The lengths in this file are pinned by `test/store_compliance/listing_metadata_test.dart`. An earlier
draft claimed the subtitle was 29 characters and the short description fit in 80; they were 40 and
86, and both consoles would have refused them.

## Category

- **App Store:** Education (primary). No secondary category needed — the app has no distinct
  second use case (e.g., no games, no standalone productivity tool).
- **Play Console:** Education.

## Age rating / content rating

Expected **4+ (App Store) / Everyone (Play, PEGI 3)**, not in Apple's Kids Category, with the
under-13 groups selected on Play. The question-by-question answers, and the record of what each
console actually issued, are in `docs/compliance/store-audience-and-age-ratings.md` (ST-309). The
children's-data basis behind them, which counsel must confirm before submission, is in
`docs/compliance/childrens-data-dossier.md`.

## URLs

| Field                 | Value                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| Support URL             | `https://studafy.com/support` — confirm this path exists before submission; not verified as part of this ticket. |
| Marketing URL (optional) | `https://studafy.com`                                                |
| Privacy policy URL      | `https://app.studafy.com/privacy` (`PrivacyPolicyPage.tsx`) — the same URL the app opens from the login screen and Profile tab (`legal_links.dart`). Legal sign-off still recommended; see `review-checklist.md`. |
| Account deletion URL (Play Data Safety) | `https://app.studafy.com/legal/delete-account` — public, no sign-in required. |

Both pages are served by `apps/web` at `app.studafy.com`, which had no DNS record on 2026-10-01;
`studafy.com` is a separate site. See `privacy-labels.md`'s open items before entering either URL.

## Localization

The app ships `en` and `ar` translations (`assets/translations/`). Both stores support localized
listings — App Store Connect and Play Console each let you add an `ar` (Arabic) listing alongside
`en-US`. Translate this file's copy into Arabic for that listing when it's ready; matching the
in-app translations' tone (`assets/translations/ar.json`) rather than a fresh translation keeps the
listing and the app consistent.
