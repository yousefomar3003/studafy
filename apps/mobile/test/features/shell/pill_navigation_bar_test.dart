import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/shell/domain/shell_role.dart';
import 'package:studafy_mobile/src/features/shell/presentation/pill_navigation_bar.dart';
import 'package:studafy_mobile/src/features/shell/presentation/shell_destinations.dart';

import '../../support/wrap_with_localization.dart';

/// Pumps [role]'s bottom bar alone, [selectedIndex] selected, on a [width]-wide phone.
Future<void> _pumpBar(
  WidgetTester tester, {
  required ShellRole role,
  required int selectedIndex,
  required double width,
  required Locale locale,
}) async {
  tester.view.physicalSize = Size(width, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    wrapWithLocalization(
      startLocale: locale,
      Builder(
        builder: (context) => MaterialApp(
          debugShowCheckedModeBanner: false,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          theme: AppTheme.light,
          home: Scaffold(
            bottomNavigationBar: PillNavigationBar(
              selectedIndex: selectedIndex,
              onDestinationSelected: (_) {},
              destinations: [
                for (final destination in shellDestinationsFor(role))
                  PillNavigationDestination(
                    icon: Icon(destination.icon),
                    selectedIcon: Icon(destination.selectedIcon ?? destination.icon),
                    label: destination.labelKey.tr(),
                  ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// The selected tab's label, as laid out.
RenderParagraph _selectedLabel(WidgetTester tester, String label) => tester.renderObject(
  find.descendant(of: find.byType(PillNavigationBar), matching: find.text(label)),
);

void main() {
  for (final locale in const [Locale('en'), Locale('ar')]) {
    for (final width in const [360.0, 390.0, 430.0]) {
      testWidgets(
        'every student tab shows its whole label when selected — ${locale.languageCode}, ${width.toInt()}px',
        (tester) async {
          for (final (index, destination) in shellDestinationsFor(ShellRole.student).indexed) {
            await _pumpBar(
              tester,
              role: ShellRole.student,
              selectedIndex: index,
              width: width,
              locale: locale,
            );
            final label = destination.labelKey.tr();
            final paragraph = _selectedLabel(tester, label);
            expect(paragraph.didExceedMaxLines, isFalse, reason: '"$label" is cut short');
            expect(tester.takeException(), isNull);
          }
        },
      );
    }
  }

  testWidgets('"Work & grades" keeps its icon and full label at 390px', (tester) async {
    await _pumpBar(
      tester,
      role: ShellRole.student,
      selectedIndex: 2,
      width: 390,
      locale: const Locale('en'),
    );
    expect(_selectedLabel(tester, 'Work & grades').didExceedMaxLines, isFalse);
    expect(
      find.descendant(of: find.byType(PillNavigationBar), matching: find.byIcon(Icons.assignment)),
      findsOneWidget,
    );
  });

  testWidgets('a short label keeps the full capsule', (tester) async {
    await _pumpBar(
      tester,
      role: ShellRole.student,
      selectedIndex: 0,
      width: 360,
      locale: const Locale('en'),
    );
    final label = tester.widget<Text>(
      find.descendant(of: find.byType(PillNavigationBar), matching: find.text('Home')),
    );
    expect(label.style?.fontSize, AppTheme.light.textTheme.labelLarge?.fontSize);
    expect(
      find.descendant(
        of: find.byType(PillNavigationBar),
        matching: find.byIcon(Icons.home_rounded),
      ),
      findsOneWidget,
    );
  });

  for (final role in [
    ShellRole.teacher,
    ShellRole.parent,
    ShellRole.attendanceOfficer,
    ShellRole.viewer,
  ]) {
    for (final locale in const [Locale('en'), Locale('ar')]) {
      testWidgets(
        '${role.name}: every tab shows its whole label at 360px (${locale.languageCode})',
        (tester) async {
          for (final (index, destination) in shellDestinationsFor(role).indexed) {
            await _pumpBar(tester, role: role, selectedIndex: index, width: 360, locale: locale);
            final label = destination.labelKey.tr();
            expect(
              _selectedLabel(tester, label).didExceedMaxLines,
              isFalse,
              reason: '"$label" is cut short',
            );
            expect(tester.takeException(), isNull);
          }
        },
      );
    }
  }
}
