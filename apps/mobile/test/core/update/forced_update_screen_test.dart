import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/update/forced_update_screen.dart';
import 'package:studafy_mobile/src/core/update/release_config.dart';
import 'package:studafy_mobile/src/core/update/update_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';

import '../../support/wrap_with_localization.dart';

Widget _app() {
  return ProviderScope(
    overrides: [
      currentMobilePlatformProvider.overrideWithValue(MobilePlatform.android),
    ],
    child: Builder(
      builder: (context) => MaterialApp(
        theme: AppTheme.light,
        debugShowCheckedModeBanner: false,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        home: const ForcedUpdateScreen(),
      ),
    ),
  );
}

void main() {
  testWidgets('shows the update copy and the call-to-action', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_app()));
    await tester.pumpAndSettle();

    expect(find.text('update.required.title'.tr()), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'update.required.action'.tr()), findsOneWidget);
  });

  testWidgets('cannot be dismissed with a system back gesture', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_app()));
    await tester.pumpAndSettle();

    // ForcedUpdateScreen wraps its body in PopScope(canPop: false).
    final popScope = tester.widget<PopScope>(find.byType(PopScope));
    expect(popScope.canPop, isFalse);
  });
}
