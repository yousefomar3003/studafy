import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/features/features_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_hub_providers.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_hub_status.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_usage.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ai_hub_screen.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_feature_grid.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_hub_message.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_not_active_card.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_school_inactive_notice.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_usage_meter.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_controller.dart';
import 'package:studafy_mobile/src/features/ai/store/ai_store_offer_card.dart';

import '../../../core/features/feature_fixtures.dart';
import '../../../support/wrap_with_localization.dart';
import '../store/store_fakes.dart';

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
    expect(find.byType(AiNotActiveCard), findsNothing);
    expect(find.byType(AiSchoolInactiveNotice), findsNothing);
  });

  // Builds the whole scope rather than an overrides list: riverpod 3.3.2's barrel doesn't export
  // the `Override` type (same reasoning as `exams_screen_test.dart`).
  //
  // [tutor] is the AI tutor's `GET /api/me/features` entry: by default nothing from the school, so
  // the store may sell it.
  ProviderScope unsubscribed({
    required bool sold,
    Map<String, dynamic>? tutor,
    bool featuresFail = false,
  }) => ProviderScope(
    overrides: [
      aiHubStatusProvider.overrideWith((ref) async => const AiHubUnsubscribed()),
      storeGatewayProvider.overrideWithValue(FakeGateway()),
      aiStoreBackendProvider.overrideWithValue(FakeBackend(storeSetup(purchasable: sold))),
      myFeaturesProvider.overrideWith(
        (ref) async => featuresFail
            ? throw Exception('offline')
            : featuresFrom([tutor ?? featureJson(reason: 'not_included')]),
      ),
    ],
    child: _screenApp(),
  );

  testWidgets('unsubscribed, where the store does not sell it: the notice and nothing to buy', (
    tester,
  ) async {
    await _pump(tester, unsubscribed(sold: false));

    expect(find.byType(AiNotActiveCard), findsOneWidget);
    // ST-304: no control, link, price or steering copy in the body. (The app bar's one control is
    // the ST-305 data-sharing page.)
    final body = find.byType(RefreshIndicator);
    expect(find.descendant(of: body, matching: find.byType(ButtonStyleButton)), findsNothing);
    expect(find.descendant(of: body, matching: find.byType(InkWell)), findsNothing);
    for (final steering in [r'$', 'Subscribe', 'Buy', 'Upgrade', 'website', 'Billed']) {
      expect(find.textContaining(steering), findsNothing, reason: steering);
    }
  });

  testWidgets("unsubscribed, where the store sells it: the store's price and its purchase", (
    tester,
  ) async {
    await _pump(tester, unsubscribed(sold: true));

    expect(find.byType(AiNotActiveCard), findsOneWidget);
    expect(find.byType(AiStoreOfferCard), findsOneWidget);
    // The price is the store's localized string, verbatim.
    expect(find.text('JOD 2.990 per month'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Subscribe'), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'Restore purchases'), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'Privacy policy'), findsOneWidget);
    expect(find.textContaining('Google Play'), findsOneWidget);
    // Never the way to pay outside the store.
    expect(find.textContaining('website'), findsNothing);
    expect(find.textContaining('studafy.com'), findsNothing);
  });

  testWidgets('school-inactive state shows the notice, not the not-active card', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [aiHubStatusProvider.overrideWith((ref) async => const AiHubSchoolInactive())],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiSchoolInactiveNotice), findsOneWidget);
    expect(find.byType(AiNotActiveCard), findsNothing);
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

  testWidgets('the school sells a seat with the AI tutor: ask the school, never the store', (
    tester,
  ) async {
    await _pump(
      tester,
      unsubscribed(sold: true, tutor: featureJson(reason: 'not_included', schoolOffers: true)),
    );

    expect(find.text('Ask your school for a seat'), findsOneWidget);
    expect(find.byType(AiStoreOfferCard), findsNothing);
    expect(find.widgetWithText(FilledButton, 'Subscribe'), findsNothing);
    expect(find.textContaining('JOD'), findsNothing);
  });

  testWidgets('a seat holder whose tier has no AI: never the store', (tester) async {
    await _pump(
      tester,
      unsubscribed(sold: true, tutor: featureJson(reason: 'not_included', schoolSeat: true)),
    );

    expect(find.byType(AiStoreOfferCard), findsNothing);
    expect(find.text('Ask your school for a seat'), findsOneWidget);
  });

  testWidgets('while the verdict is unknown, the notice alone: never a purchase by default', (
    tester,
  ) async {
    await _pump(tester, unsubscribed(sold: true, featuresFail: true));

    expect(find.byType(AiNotActiveCard), findsOneWidget);
    expect(find.byType(AiStoreOfferCard), findsNothing);
  });

  testWidgets('covered by a school seat: "Provided by" the school above the hub, nothing to buy', (
    tester,
  ) async {
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
          myFeaturesProvider.overrideWith(
            (ref) async => featuresFrom([
              featureJson(
                active: true,
                sources: [grant('school_license', limit: 300)],
                limit: 300,
                used: 12,
                schoolSeat: true,
              ),
            ]),
          ),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.textContaining('Provided by Alpha Academy'), findsOneWidget);
    expect(find.textContaining('12 of 300 messages used this month'), findsOneWidget);
    expect(find.byType(AiFeatureGrid), findsOneWidget);
    expect(find.byType(AiStoreOfferCard), findsNothing);
  });
}
