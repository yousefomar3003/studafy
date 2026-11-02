# Mobile accessibility audit (ST-294)

Screen-reader (TalkBack/VoiceOver), touch-target, dynamic-type, and contrast pass over
`apps/mobile`'s core journeys — login, student timetable/grades, teacher attendance/grade entry,
and the shell nav/FAB shared by every role. Static source audit plus Flutter's own
`meetsGuideline` test matchers, not a live device pass (see "What this audit is not," below).

Findings are graded **High** (blocks a core journey for an AT user), **Medium** (degrades it but
doesn't block it), or **Low** (polish / verify-on-device). Each is either **Fixed** in this ticket
or **Ticketed** with the reason it wasn't.

## Fixed

| #   | Finding                                                                                                                                                                                  | File                                                                                       | Severity | Fix                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `CircularProgressIndicator` shown during OAuth sign-in had no accessible name — TalkBack/VoiceOver announce nothing while the user waits.                                                | `features/auth/presentation/login_screen.dart`                                             | High     | Added `semanticsLabel: 'Signing in'`.                                                                                                           |
| 2   | Grade-entry's assessment-list back arrow was a bare `IconButton(Icons.arrow_back)` with no tooltip — announced as an unlabeled button.                                                   | `features/teacher/presentation/grade_entry_screen.dart`                                    | High     | Replaced with `BackButton()`, which gets `MaterialLocalizations`' own localized "Back" tooltip (and the correct RTL chevron) for free.          |
| 3   | The minutes-late stepper's `−`/`+` buttons were constrained to 32×32 — under both Android's 48dp and iOS's 44pt tap-target floor.                                                        | `features/teacher/presentation/widgets/attendance_roster_row.dart` (`_StepButton`)         | High     | Constraints bumped to 48×48.                                                                                                                    |
| 4   | The timetable's "This week" shortcut explicitly shrank its own tap target (`minimumSize: Size(0,0)`, `tapTargetSize: MaterialTapTargetSize.shrinkWrap`) to roughly 24px tall.            | `features/student/presentation/widgets/timetable_week_navigator.dart`                      | High     | Removed both overrides; falls back to `AppButtonTheme`'s themed default (padded to 48dp).                                                       |
| 5   | The minutes-late stepper's numeric readout was a fixed 28px-wide `Text` with default (clipping) overflow — a 3-digit value (up to 240) can outgrow that box at 130% dynamic type.        | `features/teacher/presentation/widgets/attendance_roster_row.dart` (`_MinutesLateStepper`) | Medium   | Widened to 32px and set `overflow: TextOverflow.visible` so a scaled value paints past the box rather than being silently truncated.            |
| 6   | A grade-entry row's `isFocused` state (which row the docked numeric keypad is currently bound to) was conveyed only by the score box's border color/fill — invisible to a screen reader. | `features/teacher/presentation/widgets/grade_entry_row.dart`                               | Medium   | Wrapped the row in `Semantics(selected: isFocused)`.                                                                                            |
| 7   | The teacher content screen's attachment-remove `IconButton(Icons.close)` had no tooltip.                                                                                                 | `features/teacher/presentation/teacher_content_screen.dart`                                | Medium   | Added `tooltip: 'Remove attachment'`.                                                                                                           |
| 8   | The shell's mutate-role `FloatingActionButton` (icon-only "+") had no tooltip.                                                                                                           | `features/shell/presentation/app_shell.dart`                                               | Low      | Added `tooltip: 'Add'`. The button itself is still an unwired stub (`onPressed: () {}`) — see "Ticketed" #6; this only fixes the missing label. |

Regression coverage: `test/a11y/accessibility_guidelines_test.dart` runs Flutter's built-in
`androidTapTargetGuideline`, `iOSTapTargetGuideline`, `labeledTapTargetGuideline`, and
`textContrastGuideline` matchers against `AttendanceRosterRow` (late status, so the stepper from
#3/#5 renders), `GradeEntryRow` (focused, from #6), and the full `AppShell` (nav bar + FAB, from
#8). This is the first automated accessibility test coverage in the app — there was none before
this ticket (`grep -r meetsGuideline apps/mobile/test` was empty).

## Ticketed (not fixed here)

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                         | Severity                 | Why not fixed now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **PDF materials are not screen-reader accessible at all.** `MaterialViewerScreen` renders PDFs via `flutter_pdfview`, a native platform view that paints pages as flattened bitmaps — no text layer reaches Flutter's semantics tree, so TalkBack/VoiceOver get nothing from the PDF itself.                                                                                                                    | **High**                 | Needs either a different renderer with a real accessibility bridge, or a documented accessible alternative — a product/architecture decision, not a patch. Partial mitigation already exists: the AI summary and key-concepts screens (ST-229) give a parallel textual reading of the same material, reachable from the same viewer's action bar.                                                                                                                                                                                        |
| 2   | The `outline`/`outlineVariant` design tokens fail WCAG 1.4.11's 3:1 non-text-contrast floor against their surface: `neutral200` on white measures **1.23:1** (light theme), `neutral700` on `neutral950` measures **1.95:1** (dark theme). Used for input/card borders and dividers app-wide (`AppInputTheme`, `AppCardTheme`, the timetable's week-navigator divider, an unfocused `GradeEntryRow` score box). | Medium                   | Every text-on-surface pair I measured in `AppColorScheme`/`AppSemanticColors` clears 4.5:1+ — this is narrowly the two border tokens. Token values are mirrored 1:1 with `packages/ui/src/theme.ts` per `AppColorScheme`'s own doc comment ("if a hex changes there, change it here too"), so this needs a cross-platform token change, not a mobile-only edit. No information is conveyed by these borders alone (every affected control also has a text label), so this degrades low-vision legibility rather than blocking a journey. |
| 3   | `GradeNumericKeypad` is a custom docked on-screen keypad (not the system IME), bound to a row by tapping its score box first. Every key already carries `Semantics(button: true, label: ...)` (including the backspace icon), so it is technically screen-reader operable via swipe navigation.                                                                                                                 | Low / verify             | Static analysis can confirm the semantics are present but can't confirm focus order feels right in practice (docked keypad vs. the scrolling roster above it) — recommend one real TalkBack/VoiceOver device pass on this specific screen before calling the grade-entry journey done.                                                                                                                                                                                                                                                   |
| 4   | Login screen has zero localization — every string, including the OAuth-cancelled `SnackBar` and the `semanticsLabel` added in fix #1, is hardcoded English. No `auth.*` namespace exists in `assets/translations/{en,ar}.json` at all.                                                                                                                                                                          | Low                      | Pre-existing i18n gap, not introduced by or specific to this audit — belongs on an i18n-coverage ticket. Noted here only because it does mean an Arabic-locale screen reader hears English on this one screen.                                                                                                                                                                                                                                                                                                                           |
| 5   | Chart widgets (e.g. `GradeTrendCard`'s sparkline `CustomPaint`) have no `Semantics` summary of their own. Not a hard failure — the same data (first/last term, min/max range) is always duplicated as adjacent `Text` right below the chart — but a screen reader user lands on the chart area itself and gets nothing.                                                                                         | Low                      | Cheap to add (`Semantics(label: '...')` wrapper) but out of scope for this pass, which prioritized defects with real user impact over blanket polish.                                                                                                                                                                                                                                                                                                                                                                                    |
| 6   | The shell's mutate-role FAB is an unwired stub (`onPressed: () {}`) across every role that has one.                                                                                                                                                                                                                                                                                                             | N/A (not an a11y defect) | Flagged only because it's now a focusable control with a label (fix #8) and genuinely does nothing when activated — worth wiring up or removing as its own product-scope ticket, separate from this audit.                                                                                                                                                                                                                                                                                                                               |

## What this audit is not

This was a static source review plus automated widget-test guideline checks, run without a real
device or an actual screen reader. It's the fast, reliable half of an audit — geometry, color,
and "does a `Semantics` node exist" are all mechanically checkable — but it cannot confirm read
order, gesture conflicts, or how any of this actually sounds and feels with TalkBack or VoiceOver
running for real. Ticketed item #3 above is the clearest case where that gap matters; treat every
"Fixed" row as verified-by-analysis, not verified-on-device.

## Method notes

- **Touch targets**: measured/verified via `androidTapTargetGuideline` (48×48) and
  `iOSTapTargetGuideline` (44×44) in `test/a11y/accessibility_guidelines_test.dart`, plus manual
  `grep` for `BoxConstraints.tightFor`, `minimumSize`, and `tapTargetSize` overrides across
  `lib/src` to find every place a widget shrinks its own default (Material's stock buttons are
  fine as shipped — `AppButtonTheme`'s `Size(64, 40)` visual size still gets padded to a 48dp tap
  target by Flutter's default `MaterialTapTargetSize.padded`, which none of these overrides is
  actually about).
- **Contrast**: WCAG 2.1 relative-luminance ratios computed directly from `AppColorTokens`' hex
  values for every pair `AppColorScheme`/`AppSemanticColors` actually assembles (not sampled from
  a running app) — text-on-surface pairs in both themes, plus the `outline`/`outlineVariant` case
  in Ticketed #2. `textContrastGuideline` in the new test file covers the same class of defect
  going forward for any widget added to that suite.
- **Dynamic type**: confirmed no `TextScaler`/`textScaleFactor` override exists anywhere between
  `MaterialApp.router` (`app.dart`) and the theme (`app_theme.dart`) — the OS's dynamic-type
  setting reaches every screen unmodified. Then grepped fixed-size `SizedBox`/`Container` boxes
  wrapping `Text` for ones with real, variable-length, non-icon content (found #5 above; most
  hits were icon-sized boxes or loading-skeleton placeholders, not a risk).
- **Screen-reader labels**: grepped every `IconButton`, `InkWell`, and `GestureDetector` in
  `lib/src/features` for a missing `tooltip`/`semanticLabel`/`Semantics` wrapper, then read each
  hit in context to judge whether the surrounding text already merges into an accessible label
  (most do) or genuinely announces nothing (findings #1, #2, #7, #8).

## What's solid already (no action needed)

- No blanket text-scale override anywhere in the app — the single biggest prerequisite for the
  130%-dynamic-type acceptance criterion was already true going in.
- Status/state is consistently backed by a text label alongside color everywhere audited
  (attendance marks, grade out-of-range, warning banners) — no color-only meaning found.
- A few spots already showed real accessibility care predating this ticket:
  `LocaleToggleButton`'s explicit `semanticsLabel`, and `GradeNumericKeypad`'s
  `Semantics(button: true, ...)` on every key including the icon-only backspace.

## Out of scope for this pass

The AI-tag features (Ask AI, exam/quiz/flashcards — `features/ai/`) were spot-checked only: every
`IconButton` there already carries a tooltip. A follow-up pass should cover them with the same
depth as the journeys above, along with a real-device screen-reader run over anything marked
"verify" here.
