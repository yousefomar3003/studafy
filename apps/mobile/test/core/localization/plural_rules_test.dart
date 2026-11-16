import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../support/wrap_with_localization.dart';

/// Pumps the app's localization with [locale] and returns `key.plural(n)` for each count.
Future<Map<int, String>> _plurals(
  WidgetTester tester,
  Locale locale,
  String key,
  List<int> counts,
) async {
  SharedPreferences.setMockInitialValues({});
  await EasyLocalization.ensureInitialized();
  await tester.runAsync(() async {
    await tester.pumpWidget(
      wrapWithLocalization(
        Builder(
          builder: (context) => MaterialApp(
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: const SizedBox(),
          ),
        ),
        startLocale: locale,
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 200));
  });
  await tester.pumpAndSettle();
  return {for (final n in counts) n: key.plural(n)};
}

void main() {
  testWidgets('Arabic counts use the few (3-10) and many (11-99) forms', (
    tester,
  ) async {
    final counts = await _plurals(
      tester,
      const Locale('ar'),
      'materials.weeks.count',
      [0, 1, 2, 3, 4, 10, 11, 99, 100],
    );
    expect(counts[0], 'لا توجد مواد');
    expect(counts[1], 'مادة واحدة');
    expect(counts[2], 'مادتان');
    expect(counts[3], '3 مواد');
    expect(counts[4], '4 مواد');
    expect(counts[10], '10 مواد');
    expect(counts[11], '11 مادة');
    expect(counts[99], '99 مادة');
    expect(counts[100], '100 مادة');
  });

  testWidgets('English counts are unchanged', (tester) async {
    final counts = await _plurals(
      tester,
      const Locale('en'),
      'materials.weeks.count',
      [1, 2, 4],
    );
    expect(counts[1], '1 material');
    expect(counts[2], '2 materials');
    expect(counts[4], '4 materials');
  });
}
