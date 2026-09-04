import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/shell/presentation/app_shell.dart';

import '../../support/pump_studafy_app.dart';
import '../../support/wrap_with_localization.dart';

/// Pumps [AppShell] at a fixed surface/DPI/text-scale — a golden must be reproducible across
/// machines regardless of the host's default window size or accessibility text scale — under
/// [locale]. Setting `locale` (not just wrapping in [Directionality]) is the point of these
/// goldens: it proves the RTL flip comes for free from `MaterialApp`'s own locale resolution,
/// with no manual `Directionality` override anywhere in the shell.
///
/// The Arabic goldens render their glyphs as tofu boxes — `flutter test`'s headless font
/// manager has no system font fallback and this app only bundles the Latin-only Inter family
/// (`assets/fonts/`), so there is nothing on this machine that can shape Arabic text. Real
/// devices resolve missing glyphs through the OS's own font fallback (Noto Sans Arabic /
/// Geeza Pro, ...) the same way any app relying on a custom Latin font does; these goldens
/// exist to pin down *layout* mirroring (tab order, alignment, FAB side, icon direction), not
/// glyph shaping.
Future<void> _pumpShellGolden(
  WidgetTester tester, {
  required List<String> roles,
  required Locale locale,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    KeyedSubtree(
      key: UniqueKey(),
      child: wrapWithLocalization(
        ProviderScope(
          overrides: [
            authSessionProvider.overrideWithValue(
              await fakeAuthenticatedSession(roles: roles),
            ),
          ],
          child: Builder(
            builder: (context) {
              return MediaQuery(
                data: const MediaQueryData(textScaler: TextScaler.noScaling),
                child: MaterialApp(
                  theme: AppTheme.light,
                  debugShowCheckedModeBanner: false,
                  locale: context.locale,
                  supportedLocales: context.supportedLocales,
                  localizationsDelegates: context.localizationDelegates,
                  home: const AppShell(),
                ),
              );
            },
          ),
        ),
        startLocale: locale,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'student shell — English (LTR)',
    (tester) async {
      await _pumpShellGolden(
        tester,
        roles: const ['STUDENT'],
        locale: const Locale('en'),
      );
      await expectLater(
        find.byType(AppShell),
        matchesGoldenFile('goldens/app_shell_student_en.png'),
      );
    },
    // See kGoldenRenderDiffSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );

  testWidgets(
    'student shell — Arabic (RTL)',
    (tester) async {
      await _pumpShellGolden(
        tester,
        roles: const ['STUDENT'],
        locale: const Locale('ar'),
      );
      await expectLater(
        find.byType(AppShell),
        matchesGoldenFile('goldens/app_shell_student_ar.png'),
      );
    },
    // See kGoldenRenderDiffSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );

  testWidgets(
    'viewer shell (view-only banner) — English (LTR)',
    (tester) async {
      await _pumpShellGolden(
        tester,
        roles: const ['ORG_ADMIN'],
        locale: const Locale('en'),
      );
      await expectLater(
        find.byType(AppShell),
        matchesGoldenFile('goldens/app_shell_viewer_en.png'),
      );
    },
    // See kGoldenRenderDiffSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );

  testWidgets(
    'viewer shell (view-only banner) — Arabic (RTL)',
    (tester) async {
      await _pumpShellGolden(
        tester,
        roles: const ['ORG_ADMIN'],
        locale: const Locale('ar'),
      );
      await expectLater(
        find.byType(AppShell),
        matchesGoldenFile('goldens/app_shell_viewer_ar.png'),
      );
    },
    // See kGoldenRenderDiffSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );
}
