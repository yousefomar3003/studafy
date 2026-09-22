# Screenshot plan

Shot list per role journey, mapped to the actual screens each shell renders
(`apps/mobile/lib/src/features/shell/presentation/shell_destinations.dart`), not a generic
template. Four role journeys, matching `ShellRole` (`shell_role.dart`): student, teacher, parent,
viewer. The `viewer` shell (super admin / org admin / finance / support-agent sessions) is
read-only and mobile-secondary — see below for whether it needs its own screenshots at all.

## Rule: no real student data in a screenshot

Every screenshot must come from seeded demo data, not a real school's account. Grades, attendance,
discipline incidents (`teacher/presentation/incident_report_screen.dart`), and finance receipts
(`parent/presentation/receipt_viewer_screen.dart`) all show identifiable-looking student
information — capturing a real tenant's data for a public store listing would itself be the kind of
disclosure this ticket's privacy review exists to prevent. Use a dedicated demo/staging tenant with
fabricated names, or the seed data `db/seeds/seed.ts` already produces for local dev, whichever is
already staging-realistic.

## Required sizes

Both stores accept a device-independent capture set as long as it covers each required display
class; oversized captures get scaled down at review, undersized ones get rejected outright.

| Store      | Required                                                                                    | Count               |
| ---------- | --------------------------------------------------------------------------------------------- | -------------------- |
| App Store  | 6.9" (iPhone 16 Pro Max class) — mandatory. 6.5" is accepted as a fallback if 6.9" is supplied, so only one iPhone size set is strictly required. iPad screenshots only if the app is marked iPad-compatible. | 3–10 per size, per localization |
| Play       | Phone — mandatory. 7" and 10" tablet — required only if the store listing targets tablets.    | 2–8 (phone)          |

Check whether the Flutter build actually supports tablet/iPad layouts before deciding whether to
capture those sets — nothing in `apps/mobile/lib/src/design` was reviewed for tablet-specific
layout as part of this ticket; if it's phone-only, mark the app phone-only in each console and skip
the tablet/iPad screenshot sets rather than stretching phone captures.

## Shot list

### Student journey (5–6 shots)

1. `TodayScreen` — today's timetable + due-soon assignments + new grades (the home tab; the single
   best "what does this app do" first impression).
2. `TimetableScreen` — the week view.
3. `ExamsScreen` or `AssignmentDetailScreen` — one concrete assignment/exam, showing due date and
   status.
4. `AiHubScreen` in its **subscribed** state — the feature grid (Ask AI, Exam mode, Summaries, Key
   concepts, Flashcards, Quizzes; see `ai/presentation/widgets/ai_feature_grid.dart`). Do **not**
   capture the unsubscribed state (`AiUpsellCard`) for the listing — it's an upsell surface, not a
   feature showcase, and its own copy is deliberately price-free; a screenshot of it adds nothing
   the description text doesn't already say better.
5. `GradesScreen` — grades list.
6. Optional: `AttendanceScreen`.

### Teacher journey (4–5 shots)

1. `TeacherHomeScreen` — today's classes.
2. `TeacherClassDetailScreen` — one class's roster/detail view.
3. `AttendanceTakingScreen` — taking attendance (a concrete "this saves teachers time" moment).
4. `GradeEntryScreen` — entering grades.
5. Optional: `ClassAnnouncementComposerScreen`.

### Parent journey (4–5 shots)

1. `ParentHomeScreen` — the overview, showing the per-child selector.
2. `ChildDetailScreen` — one child's timetable/grades/attendance.
3. `ComparisonScreen` — the across-children comparison view, if a demo account has 2+ children
   seeded (this is a genuinely distinctive feature worth a shot).
4. `ParentCommunicationScreen` — the Messages/Alerts tabs (school announcements +
   attendance-alert notifications).
5. Do not capture `receipt_viewer_screen.dart` — it displays financial data (invoice amounts) that
   reads poorly out of context in a public listing and adds no value the description doesn't
   already cover in one line.

### Viewer (admin/finance/support) journey — recommend skipping

`ShellRole.viewer` exists so admin-type sessions have *something* usable on mobile, but per
`shell_role.dart`'s own doc comment, "their real workflows live on the web admin console" — mobile
is explicitly not their primary surface, and the shell is view-only with a persistent
view-only banner (`view_only_banner.dart`). Recommend **not** spending screenshot slots on
`AdminOverviewScreen`/`FinanceOverviewScreen`: they're not the app's selling point for anyone
downloading it from a store listing (nobody searches the App Store looking for a finance viewer),
and store review doesn't require every role to be represented, only that the screenshots
accurately represent what most users see.

## Localization

Capture the `en` set first. Whether an `ar` capture set is worth producing depends on whether the
`ar` store listing (see `listing-metadata.md`) ships at the same time — if it does, both stores
require localized screenshots for a localized listing, not just localized text; recapture the same
shot list with the device locale set to `ar` and RTL layout, rather than reusing the `en` images
under an `ar` listing (both stores' review guidelines flag that mismatch).

## How to capture

No existing tooling in this repo automates mobile screenshot capture (unlike
`apps/web/e2e/help-screenshots.spec.ts`, which is Playwright-driven for the web help center — there
is no Flutter-side equivalent). Capture manually from a simulator/emulator or device at each
required size, against the seeded demo tenant. If this becomes a recurring release step, a Flutter
integration-test-driven capture (mirroring the web help-center approach) would be worth building —
not done here since it wasn't asked for and this ticket is about listing content, not tooling.
