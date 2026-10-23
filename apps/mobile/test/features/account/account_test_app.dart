import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';

import '../../support/wrap_with_localization.dart';

/// Pumps [scope] (a `ProviderScope` with the screen under test as its descendant, built by
/// [accountScreenApp]) under the same localization wiring the app uses.
Future<void> pumpAccountScreen(WidgetTester tester, Widget scope) async {
  tester.view
    ..physicalSize = const Size(390, 1600)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(wrapWithLocalization(scope));
  await tester.pumpAndSettle();
}

/// A themed, localized [MaterialApp] around [screen].
Widget accountScreenApp(Widget screen) {
  return Builder(
    builder: (context) => MaterialApp(
      theme: AppTheme.light,
      debugShowCheckedModeBanner: false,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      home: screen,
    ),
  );
}
