import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/features/features_providers.dart';
import 'package:studafy_mobile/src/core/features/my_features.dart';
import 'package:studafy_mobile/src/core/features/presentation/feature_gate_view.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';

import '../../support/wrap_with_localization.dart';
import 'feature_fixtures.dart';

/// The gate as a person sees it, one state each: the screen when covered; "ask your school" (never
/// a purchase) when the school provides it; the paywall only when nothing from the school applies;
/// school inactive; paused. And the coverage banner: "Provided by" the school, the subscription
/// that won't renew (with the App Store steps where Studafy cannot stop it), usage, limit reached.
const _screen = Text('THE PAID SCREEN');
const _paywall = Text('THE STORE PAYWALL');

Future<void> _pump(
  WidgetTester tester,
  List<Map<String, dynamic>> features,
  Widget child,
) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          myFeaturesProvider.overrideWith(
            (ref) async => featuresFrom(features, school: 'Alpha Academy'),
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: child,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

const _gate = FeatureGate(
  featureKey: FeatureKeys.aiTutor,
  whenPurchasable: _paywallBuilder,
  child: _screen,
);

Widget _paywallBuilder(BuildContext context) => _paywall;

void _expectNothingToBuy() {
  expect(find.text('THE STORE PAYWALL'), findsNothing);
  expect(find.byType(ButtonStyleButton), findsNothing);
  for (final word in ['Subscribe', 'Buy', r'$']) {
    expect(find.textContaining(word), findsNothing, reason: word);
  }
}

void main() {
  group('FeatureGate', () {
    testWidgets('covered: the screen itself', (tester) async {
      await _pump(tester, [
        featureJson(
          active: true,
          sources: [grant('school_license')],
          schoolSeat: true,
        ),
      ], _gate);
      expect(find.text('THE PAID SCREEN'), findsOneWidget);
    });

    testWidgets(
      'the school provides it: "Ask your school for a seat", nothing to buy',
      (tester) async {
        await _pump(tester, [
          featureJson(reason: 'not_included', schoolOffers: true),
        ], _gate);
        expect(find.text('THE PAID SCREEN'), findsNothing);
        expect(find.text('Ask your school for a seat'), findsOneWidget);
        expect(
          find.textContaining('Alpha Academy provides this'),
          findsOneWidget,
        );
        _expectNothingToBuy();
      },
    );

    testWidgets('a seat holder whose tier lacks it: still never the store', (
      tester,
    ) async {
      await _pump(tester, [
        featureJson(reason: 'not_included', schoolSeat: true),
      ], _gate);
      expect(find.text('Ask your school for a seat'), findsOneWidget);
      expect(
        find.textContaining("Your seat from Alpha Academy doesn't include"),
        findsOneWidget,
      );
      _expectNothingToBuy();
    });

    testWidgets('nothing from the school: the existing store paywall', (
      tester,
    ) async {
      await _pump(tester, [featureJson(reason: 'not_included')], _gate);
      expect(find.text('THE STORE PAYWALL'), findsOneWidget);
      expect(find.text('THE PAID SCREEN'), findsNothing);
    });

    testWidgets(
      'no paywall of its own: a plain notice, with when access ended',
      (tester) async {
        await _pump(tester, [
          featureJson(reason: 'expired', periodEnd: '2026-10-01T00:00:00.000Z'),
        ], const FeatureGate(featureKey: FeatureKeys.aiTutor, child: _screen));
        expect(find.text('Not included yet'), findsOneWidget);
        expect(find.text('Your access ended on Oct 1, 2026.'), findsOneWidget);
      },
    );

    testWidgets('school inactive: its own notice', (tester) async {
      await _pump(tester, [
        featureJson(reason: 'school_inactive', schoolOffers: true),
      ], _gate);
      expect(
        find.text("Your school's Studafy plan isn't active"),
        findsOneWidget,
      );
      _expectNothingToBuy();
    });

    testWidgets('paused by Studafy: its own notice', (tester) async {
      await _pump(tester, [featureJson(reason: 'paused')], _gate);
      expect(find.text('Temporarily unavailable'), findsOneWidget);
      _expectNothingToBuy();
    });
  });

  group('FeatureCoverageBanner', () {
    const banner = Scaffold(
      body: FeatureCoverageBanner(
        featureKey: FeatureKeys.aiTutor,
        unitKey: 'features.units.messages',
      ),
    );

    testWidgets(
      'covered by a seat: "Provided by" the school and this month\'s usage',
      (tester) async {
        await _pump(tester, [
          featureJson(
            active: true,
            sources: [grant('school_license', limit: 300)],
            limit: 300,
            used: 120,
            schoolSeat: true,
          ),
        ], banner);
        expect(
          find.textContaining('Provided by Alpha Academy'),
          findsOneWidget,
        );
        expect(
          find.textContaining('120 of 300 messages used this month'),
          findsOneWidget,
        );
        expect(find.textContaining("won't renew"), findsNothing);
      },
    );

    testWidgets(
      "covered by both: the subscription won't renew after its end date",
      (tester) async {
        await _pump(tester, [
          featureJson(
            active: true,
            sources: [
              grant('school_license'),
              grant('purchase', periodEnd: '2026-11-20T12:00:00.000Z'),
            ],
            schoolSeat: true,
            renewalStop: {
              'provider': 'tap',
              'action': 'cancel_at_period_end',
              'status': 'done',
            },
          ),
        ], banner);
        expect(
          find.textContaining(
            "Your school now covers this. Your subscription won't renew after Nov 20, 2026.",
          ),
          findsOneWidget,
        );
        expect(find.textContaining('App Store'), findsNothing);
      },
    );

    testWidgets(
      'covered by both through the App Store: how to turn renewal off',
      (tester) async {
        await _pump(tester, [
          featureJson(
            active: true,
            sources: [grant('school_license'), grant('purchase')],
            schoolSeat: true,
            renewalStop: {
              'provider': 'app_store',
              'action': 'notify_user',
              'status': 'notified',
            },
          ),
        ], banner);
        expect(
          find.textContaining(
            "Apple doesn't let Studafy stop App Store renewals",
          ),
          findsOneWidget,
        );
        expect(find.textContaining('Settings'), findsOneWidget);
        // Instructions only: no link, no button.
        expect(find.byType(ButtonStyleButton), findsNothing);
      },
    );

    testWidgets('limit reached: "Monthly limit reached, resets on" the 1st', (
      tester,
    ) async {
      await _pump(tester, [
        featureJson(
          active: true,
          sources: [grant('school_license', limit: 300)],
          limit: 300,
          used: 300,
          reason: 'limit_reached',
          schoolSeat: true,
        ),
      ], banner);
      expect(find.text('Monthly limit reached'), findsOneWidget);
      expect(
        find.textContaining('Monthly limit reached, resets on '),
        findsOneWidget,
      );
    });

    testWidgets('covered personally with nothing to count: no banner', (
      tester,
    ) async {
      await _pump(tester, [
        featureJson(active: true, sources: [grant('purchase')], unit: null),
      ], banner);
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('shown in Arabic too', (tester) async {
      await tester.pumpWidget(
        wrapWithLocalization(
          ProviderScope(
            overrides: [
              myFeaturesProvider.overrideWith(
                (ref) async => featuresFrom([
                  featureJson(
                    active: true,
                    sources: [grant('school_license')],
                    schoolSeat: true,
                  ),
                ]),
              ),
            ],
            child: Builder(
              builder: (context) => MaterialApp(
                locale: context.locale,
                supportedLocales: context.supportedLocales,
                localizationsDelegates: context.localizationDelegates,
                home: banner,
              ),
            ),
          ),
          startLocale: const Locale('ar'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('مقدَّمة من Alpha Academy'), findsOneWidget);
    });
  });
}
