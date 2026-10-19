import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/locale_rebuild_scope.dart';

import '../../support/wrap_with_localization.dart';

/// A `const` widget whose label comes from context-less `tr()` — exactly the shape of the shell's
/// tab labels, which nothing rebuilds on a locale switch.
class _StaticLabel extends StatelessWidget {
  const _StaticLabel();

  @override
  Widget build(BuildContext context) => Text('shell.tabs.home'.tr());
}

Future<void> _pump(WidgetTester tester) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      Builder(
        builder: (context) => MaterialApp(
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          builder: (context, child) => LocaleRebuildScope(child: child!),
          home: const Scaffold(body: _StaticLabel()),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _switchToArabic(WidgetTester tester) async {
  final context = tester.element(find.byType(_StaticLabel));
  // ar.json is over the 50 KB threshold above which `rootBundle.loadString` decodes on a
  // background isolate, which never completes inside the test's fake-async zone.
  await tester.runAsync(() => context.setLocale(const Locale('ar')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('re-resolves context-less tr() strings when the locale changes', (
    tester,
  ) async {
    await _pump(tester);
    expect(find.text('Home'), findsOneWidget);

    await _switchToArabic(tester);

    expect(find.text('الرئيسية'), findsOneWidget);
    expect(find.text('Home'), findsNothing);
  });
}
