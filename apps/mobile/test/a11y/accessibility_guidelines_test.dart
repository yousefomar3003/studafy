import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/domain/attendance_taking.dart';
import 'package:studafy_mobile/src/features/teacher/domain/grade_entry.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/attendance_roster_row.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/widgets/grade_entry_row.dart';

import '../support/pump_app_shell.dart';
import '../support/pump_studafy_app.dart';
import '../support/wrap_with_localization.dart';

/// Regression coverage for the ST-294 accessibility audit, using Flutter's own built-in
/// guideline checkers instead of hand-rolled measurements — see the audit report
/// (`docs/mobile-a11y-audit.md`) for the full findings this backs.
///
/// Each of these widgets shipped with a real violation the audit found (a 32x32 stepper button,
/// a shrink-wrapped "this week" link, an unlabeled FAB); these tests exist so a future change
/// can't silently reintroduce one.
void main() {
  /// Fits each widget in a phone-width column, same as its real list/screen context — the
  /// guideline checkers measure actual laid-out semantics rects, not intrinsic size.
  Widget phoneWidth(Widget child) => MaterialApp(
    theme: AppTheme.light,
    debugShowCheckedModeBanner: false,
    home: Scaffold(body: SizedBox(width: 360, child: child)),
  );

  group('AttendanceRosterRow', () {
    testWidgets('late row (minutes-late stepper) meets tap-target and label guidelines', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();

      await tester.pumpWidget(
        wrapWithLocalization(
          ProviderScope(
            child: phoneWidth(
              AttendanceRosterRow(
                studentId: 's1',
                mark: const AttendanceMark(
                  studentId: 's1',
                  status: AttendanceMarkStatus.late,
                  minutesLate: 5,
                ),
                onCycle: () {},
                onMinutesLateChanged: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      await expectLater(tester, meetsGuideline(textContrastGuideline));

      handle.dispose();
    });
  });

  group('GradeEntryRow', () {
    testWidgets('an editable, focused row meets tap-target, label and contrast guidelines', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();

      await tester.pumpWidget(
        wrapWithLocalization(
          phoneWidth(
            GradeEntryRow(
              studentLabel: 'Ahmad Al-Sayed',
              scoreText: '8',
              maxScore: 10,
              status: GradeSubmissionStatus.draft,
              isFocused: true,
              isOutOfRange: false,
              isDirty: true,
              onTap: () {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      await expectLater(tester, meetsGuideline(textContrastGuideline));

      handle.dispose();
    });
  });

  group('AppShell', () {
    testWidgets('student shell (nav bar + mutate FAB) meets tap-target and label guidelines', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();

      await pumpAppShell(tester, session: await fakeAuthenticatedSession(roles: const ['STUDENT']));

      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));

      handle.dispose();
    });
  });
}
