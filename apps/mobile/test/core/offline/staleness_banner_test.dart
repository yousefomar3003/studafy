import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/offline/staleness_banner.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';

import '../../support/wrap_with_localization.dart';

Future<void> _pumpBanner(WidgetTester tester, DateTime fetchedAt) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          debugShowCheckedModeBanner: false,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: Scaffold(body: StalenessBanner(fetchedAt: fetchedAt)),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders "just now" for a value fetched moments ago', (tester) async {
    await _pumpBanner(tester, DateTime.now());

    expect(find.textContaining('just now'), findsOneWidget);
  });

  testWidgets('renders minutes for a value fetched under an hour ago', (tester) async {
    await _pumpBanner(tester, DateTime.now().subtract(const Duration(minutes: 5)));

    expect(find.textContaining('5m ago'), findsOneWidget);
  });

  testWidgets('renders hours for a value fetched under a day ago', (tester) async {
    await _pumpBanner(tester, DateTime.now().subtract(const Duration(hours: 3)));

    expect(find.textContaining('3h ago'), findsOneWidget);
  });

  testWidgets('renders days for a value fetched a day or more ago', (tester) async {
    await _pumpBanner(tester, DateTime.now().subtract(const Duration(days: 2)));

    expect(find.textContaining('2d ago'), findsOneWidget);
  });
}
