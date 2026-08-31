import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_hub_providers.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_hub_status.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_usage.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ai_hub_screen.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_feature_grid.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_hub_message.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_school_inactive_notice.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_upsell_card.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_usage_meter.dart';

import '../../../support/wrap_with_localization.dart';

Widget _screenApp() {
  return Builder(
    builder: (context) => MaterialApp(
      theme: AppTheme.light,
      debugShowCheckedModeBanner: false,
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
      home: const AiHubScreen(),
    ),
  );
}

Future<void> _pump(WidgetTester tester, ProviderScope scope) async {
  await tester.pumpWidget(wrapWithLocalization(scope));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('subscribed state shows the usage meter and the feature hub grid', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          aiHubStatusProvider.overrideWith(
            (ref) async => AiHubSubscribed(
              AiUsage(
                budget: 1000,
                usedTokens: 200,
                heldTokens: 0,
                remaining: 800,
                periodEnd: DateTime(2026, 3, 1),
              ),
            ),
          ),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiUsageMeter), findsOneWidget);
    expect(find.byType(AiFeatureGrid), findsOneWidget);
    expect(find.byType(AiUpsellCard), findsNothing);
    expect(find.byType(AiSchoolInactiveNotice), findsNothing);
  });

  testWidgets('unsubscribed state shows the upsell card with no price anywhere', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          aiHubStatusProvider.overrideWith((ref) async => const AiHubUnsubscribed()),
          aiCheckoutUrlProvider.overrideWithValue(Uri.parse('https://app.studafy.com/account/ai')),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiUpsellCard), findsOneWidget);
    expect(find.text('Continue on the website'), findsOneWidget);
    // R-07: this app never shows a price or a purchase control of its own.
    expect(find.textContaining(r'$'), findsNothing);
    expect(find.textContaining('Subscribe'), findsNothing);
  });

  testWidgets(
    "unsubscribed state disables the website action when checkout isn't configured",
    (tester) async {
      await _pump(
        tester,
        ProviderScope(
          overrides: [
            aiHubStatusProvider.overrideWith((ref) async => const AiHubUnsubscribed()),
            aiCheckoutUrlProvider.overrideWithValue(null),
          ],
          child: _screenApp(),
        ),
      );

      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(button.onPressed, isNull);
    },
  );

  testWidgets('school-inactive state shows the notice, not the upsell card', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [aiHubStatusProvider.overrideWith((ref) async => const AiHubSchoolInactive())],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiSchoolInactiveNotice), findsOneWidget);
    expect(find.byType(AiUpsellCard), findsNothing);
  });

  testWidgets('unavailable state shows the unavailable message', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [aiHubStatusProvider.overrideWith((ref) async => const AiHubUnavailable())],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiHubMessage), findsOneWidget);
    expect(find.text("AI features aren't available yet."), findsOneWidget);
  });

  testWidgets('a fetch error shows the error message', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          aiHubStatusProvider.overrideWith((ref) async => throw Exception('boom')),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiHubMessage), findsOneWidget);
    expect(find.text("Couldn't load your AI features."), findsOneWidget);
  });
}
