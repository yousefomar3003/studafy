import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/features/features_providers.dart';
import 'package:studafy_mobile/src/core/features/my_features.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/family_plus_coverage_card.dart';

import '../../../core/features/feature_fixtures.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

/// Family+ for a parent whose children are at more than one school: a school's seat covers the
/// children at that school (named), and the card says children elsewhere need the personal Family+
/// or their own school's seat; a personal Family+ covers everyone; an uncovered parent at a school
/// that sells Family+ is told to ask it -- and is never sold anything here.
Map<String, dynamic> _familyPlus({
  bool active = false,
  List<Map<String, dynamic>> sources = const [],
  String? reason,
  bool schoolSeat = false,
  bool schoolOffers = false,
  Map<String, dynamic>? renewalStop,
}) => featureJson(
  key: FeatureKeys.familyPlus,
  unit: null,
  active: active,
  sources: sources,
  reason: reason,
  schoolSeat: schoolSeat,
  schoolOffers: schoolOffers,
  renewalStop: renewalStop,
);

Future<void> _pump(WidgetTester tester, Map<String, dynamic> familyPlus) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          myFeaturesProvider.overrideWith(
            (ref) async => featuresFrom([familyPlus], school: 'Alpha Academy'),
          ),
          childComparisonProvider.overrideWith(
            (ref) => comparisonReport([
              childItem(id: 'child-1', name: 'Amir'),
              childItem(id: 'child-2', name: 'Lina'),
            ]),
          ),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: const Scaffold(body: FamilyPlusCoverageCard()),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    "a school seat: this school's children named, other schools' children not covered",
    (tester) async {
      await _pump(
        tester,
        _familyPlus(
          active: true,
          sources: [grant('school_license')],
          schoolSeat: true,
        ),
      );

      expect(
        find.text(
          'Alpha Academy covers Family+ for your children at Alpha Academy: Amir, Lina.',
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining(
          "Children at other schools aren't covered by the Alpha Academy seat",
        ),
        findsOneWidget,
      );
      expect(find.textContaining('your own Family+'), findsOneWidget);
      expect(find.byType(ButtonStyleButton), findsNothing);
    },
  );

  testWidgets('a personal Family+: every child, every school', (tester) async {
    await _pump(
      tester,
      _familyPlus(active: true, sources: [grant('purchase')]),
    );

    expect(find.text('Your Family+ covers all your children.'), findsOneWidget);
    expect(find.textContaining('other schools'), findsNothing);
  });

  testWidgets(
    'a seat and a personal Family+: the personal one will not renew',
    (tester) async {
      await _pump(
        tester,
        _familyPlus(
          active: true,
          sources: [
            grant('school_license'),
            grant('purchase', periodEnd: '2026-12-01T12:00:00.000Z'),
          ],
          schoolSeat: true,
          renewalStop: {
            'provider': 'app_store',
            'action': 'notify_user',
            'status': 'notified',
          },
        ),
      );

      expect(
        find.textContaining("won't renew after Dec 1, 2026"),
        findsOneWidget,
      );
      expect(find.textContaining('Settings'), findsOneWidget);
      // The per-school scope still applies to the seat.
      expect(find.textContaining('Children at other schools'), findsOneWidget);
    },
  );

  testWidgets(
    'not covered, the school sells Family+: ask the school, nothing to buy',
    (tester) async {
      await _pump(
        tester,
        _familyPlus(reason: 'not_included', schoolOffers: true),
      );

      expect(
        find.text(
          'Alpha Academy offers Family+ through its license. Ask the school for a parent seat.',
        ),
        findsOneWidget,
      );
      expect(find.byType(ButtonStyleButton), findsNothing);
    },
  );

  testWidgets(
    'not covered and nothing from the school: says so, sells nothing',
    (tester) async {
      await _pump(tester, _familyPlus(reason: 'not_included'));

      expect(
        find.text("Family+ isn't active for your account at this school."),
        findsOneWidget,
      );
      expect(find.byType(ButtonStyleButton), findsNothing);
    },
  );
}
