import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/features/features_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/today_ai_promo.dart';

import '../../../../core/features/feature_fixtures.dart';
import '../../../../support/wrap_with_localization.dart';

Future<ProviderContainer> _pump(WidgetTester tester, List<Map<String, dynamic>> features) async {
  final container = ProviderContainer(
    overrides: [myFeaturesProvider.overrideWith((ref) async => featuresFrom(features))],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    wrapWithLocalization(
      UncontrolledProviderScope(
        container: container,
        child: Builder(
          builder: (context) => MaterialApp(
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: const Scaffold(body: TodayAiPromo()),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

void main() {
  testWidgets('offered to a student who could buy the AI add-on, and opens the AI tab', (
    tester,
  ) async {
    final container = await _pump(tester, [featureJson(reason: 'not_included')]);

    expect(find.text('Studafy AI'), findsOneWidget);

    await tester.tap(find.text('Explore'));
    await tester.pump();
    expect(container.read(selectedShellTabProvider), 'shell.tabs.ai');
  });

  testWidgets('hidden from a student who already has AI', (tester) async {
    await _pump(tester, [
      featureJson(active: true, sources: [grant('purchase')]),
    ]);

    expect(find.text('Studafy AI'), findsNothing);
  });

  testWidgets('hidden where the school would provide it: never sold in the app', (tester) async {
    await _pump(tester, [featureJson(reason: 'not_included', schoolOffers: true)]);

    expect(find.text('Studafy AI'), findsNothing);
  });
}
