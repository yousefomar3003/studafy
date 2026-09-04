import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_hub_providers.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_hub_status.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_usage.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ai_usage_screen.dart';
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
      home: const AiUsageScreen(),
    ),
  );
}

AiUsage _usage({
  required int budget,
  required int usedTokens,
  int heldTokens = 0,
}) {
  return AiUsage(
    budget: budget,
    usedTokens: usedTokens,
    heldTokens: heldTokens,
    remaining: budget - usedTokens - heldTokens,
    periodEnd: DateTime(2026, 3, 1),
  );
}

Future<void> _pump(WidgetTester tester, ProviderScope scope) async {
  await tester.pumpWidget(wrapWithLocalization(scope));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('normal usage shows the meter with no warning banner', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          aiHubStatusProvider.overrideWith(
            (ref) async =>
                AiHubSubscribed(_usage(budget: 1000, usedTokens: 200)),
          ),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiUsageMeter), findsOneWidget);
    expect(find.textContaining("nearing this month's AI limit"), findsNothing);
    expect(find.textContaining("used this month's AI budget"), findsNothing);
  });

  testWidgets('nearing-limit usage warns while budget still remains', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          aiHubStatusProvider.overrideWith(
            (ref) async =>
                AiHubSubscribed(_usage(budget: 1000, usedTokens: 850)),
          ),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiUsageMeter), findsOneWidget);
    expect(
      find.text(
        "You're nearing this month's AI limit. See the reset date below.",
      ),
      findsOneWidget,
    );
  });

  testWidgets('exhausted usage shows the hard-stop message', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          aiHubStatusProvider.overrideWith(
            (ref) async =>
                AiHubSubscribed(_usage(budget: 1000, usedTokens: 1000)),
          ),
        ],
        child: _screenApp(),
      ),
    );

    expect(
      find.text(
        "You've used this month's AI budget. It resets on the date below.",
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'unsubscribed state shows the upsell card, not the meter',
    (tester) async {
      await _pump(
        tester,
        ProviderScope(
          overrides: [
            aiHubStatusProvider.overrideWith(
              (ref) async => const AiHubUnsubscribed(),
            ),
          ],
          child: _screenApp(),
        ),
      );

      expect(find.byType(AiUpsellCard), findsOneWidget);
      expect(find.byType(AiUsageMeter), findsNothing);
    },
    // See kKnownPreExistingFailureSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );

  testWidgets('school-inactive state shows the notice, not the meter', (
    tester,
  ) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          aiHubStatusProvider.overrideWith(
            (ref) async => const AiHubSchoolInactive(),
          ),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiSchoolInactiveNotice), findsOneWidget);
    expect(find.byType(AiUsageMeter), findsNothing);
  });

  testWidgets('a fetch error shows the error message', (tester) async {
    await _pump(
      tester,
      ProviderScope(
        overrides: [
          aiHubStatusProvider.overrideWith(
            (ref) async => throw Exception('boom'),
          ),
        ],
        child: _screenApp(),
      ),
    );

    expect(find.byType(AiHubMessage), findsOneWidget);
    expect(find.text("Couldn't load your AI features."), findsOneWidget);
  });
}
