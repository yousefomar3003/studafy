import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/features/feature_gate.dart';
import 'package:studafy_mobile/src/core/features/my_features.dart';

import 'feature_fixtures.dart';

/// The one place the gate's states are decided (`featureGateStateOf`), against the JSON
/// `GET /api/me/features` returns: covered personally / by a seat / by both (renewal off, App Store
/// steps), limit reached, ask the school (never a purchase for a seat holder), the store, school
/// inactive, paused -- and the friendly messages for the API's refusal codes.
void main() {
  final now = DateTime.utc(2026, 10, 27, 9);

  FeatureGateState gate(Map<String, dynamic> feature) => featureGateStateOf(
    featuresFrom([feature]),
    FeatureKeys.aiTutor,
    now: now,
  );

  group('parsing', () {
    test('reads every field the gate uses', () {
      final features = featuresFrom([
        featureJson(
          active: true,
          sources: [
            grant(
              'purchase',
              limit: null,
              periodEnd: '2026-11-20T00:00:00.000Z',
            ),
          ],
          limit: 300,
          used: 12,
          renewalStop: {
            'provider': 'app_store',
            'action': 'notify_user',
            'status': 'notified',
          },
          schoolSeat: true,
          schoolOffers: true,
        ),
      ]);
      final feature = features[FeatureKeys.aiTutor]!;
      expect(features.schoolName, 'Alpha Academy');
      expect(feature.active, isTrue);
      expect(feature.sources.single.source, FeatureGrantSource.purchase);
      expect(feature.sources.single.periodEnd, DateTime.utc(2026, 11, 20));
      expect(feature.limit, 300);
      expect(feature.used, 12);
      expect(feature.schoolSeat, isTrue);
      expect(feature.schoolOffers, isTrue);
      expect(feature.renewalStop!.userMustTurnOffRenewal, isTrue);
    });

    test('an unknown source or reason is ignored rather than crashing', () {
      final feature = featuresFrom([
        featureJson(sources: [grant('gift')], reason: 'something_new'),
      ])[FeatureKeys.aiTutor]!;
      expect(feature.sources, isEmpty);
      expect(feature.reason, isNull);
    });
  });

  group('featureGateStateOf', () {
    test(
      'covered by a school seat: "Provided by" the school, nothing personal',
      () {
        final state = gate(
          featureJson(
            active: true,
            sources: [grant('school_license', limit: 300)],
            limit: 300,
            used: 40,
            schoolSeat: true,
          ),
        );
        expect(state, isA<FeatureCovered>());
        state as FeatureCovered;
        expect(state.coverage, FeatureCoverage.school);
        expect(state.schoolName, 'Alpha Academy');
        expect((state.used, state.limit, state.limitReached), (40, 300, false));
        expect(state.personalEndsAt, isNull);
        expect(state.mustTurnOffAppStoreRenewal, isFalse);
      },
    );

    test('covered personally', () {
      final state = gate(
        featureJson(active: true, sources: [grant('purchase')]),
      );
      expect((state as FeatureCovered).coverage, FeatureCoverage.personal);
    });

    test(
      'covered by both: the personal end date, and renewal turned off for them',
      () {
        final state = gate(
          featureJson(
            active: true,
            sources: [
              grant('school_license', periodEnd: '2027-08-31T00:00:00.000Z'),
              grant('purchase', periodEnd: '2026-11-20T00:00:00.000Z'),
            ],
            schoolSeat: true,
            renewalStop: {
              'provider': 'tap',
              'action': 'cancel_at_period_end',
              'status': 'done',
            },
          ),
        );
        state as FeatureCovered;
        expect(state.coverage, FeatureCoverage.both);
        expect(state.personalEndsAt, DateTime.utc(2026, 11, 20));
        expect(state.mustTurnOffAppStoreRenewal, isFalse);
      },
    );

    test(
      'covered by both through the App Store: they must turn renewal off themselves',
      () {
        final state = gate(
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
        );
        expect((state as FeatureCovered).mustTurnOffAppStoreRenewal, isTrue);
      },
    );

    test(
      'limit reached: still covered, and resets on the 1st of next month (UTC)',
      () {
        final state = gate(
          featureJson(
            active: true,
            sources: [grant('school_license', limit: 300)],
            limit: 300,
            used: 300,
            reason: 'limit_reached',
          ),
        );
        state as FeatureCovered;
        expect(state.limitReached, isTrue);
        expect(state.resetsOn, DateTime.utc(2026, 11));
      },
    );

    test(
      'not covered, the school sells a seat that includes it: ask the school',
      () {
        final state = gate(
          featureJson(reason: 'not_included', schoolOffers: true),
        );
        expect(state, isA<FeatureAskSchool>());
        expect((state as FeatureAskSchool).hasSeat, isFalse);
        expect(state.schoolName, 'Alpha Academy');
      },
    );

    test(
      'a seat holder whose tier lacks the feature is never offered a purchase',
      () {
        final state = gate(
          featureJson(reason: 'not_included', schoolSeat: true),
        );
        expect(state, isA<FeatureAskSchool>());
        expect((state as FeatureAskSchool).hasSeat, isTrue);
      },
    );

    test('not covered and nothing from the school: the store', () {
      expect(
        gate(featureJson(reason: 'not_included')),
        isA<FeaturePurchasable>(),
      );
      final expired = gate(
        featureJson(reason: 'expired', periodEnd: '2026-10-01T00:00:00.000Z'),
      );
      expect((expired as FeaturePurchasable).expiredOn, DateTime.utc(2026, 10));
    });

    test('school inactive, paused, and a feature not listed', () {
      expect(
        gate(featureJson(reason: 'school_inactive', schoolOffers: true)),
        isA<FeatureSchoolInactive>(),
      );
      expect(gate(featureJson(reason: 'paused')), isA<FeatureUnavailable>());
      expect(
        featureGateStateOf(
          featuresFrom(const []),
          FeatureKeys.notebook,
          now: now,
        ),
        isA<FeatureUnavailable>(),
      );
    });
  });

  test('usage resets on the 1st of the next month, across a year end', () {
    expect(usageResetsOn(DateTime.utc(2026, 12, 31, 23)), DateTime.utc(2027));
  });

  test('maps refusal codes to friendly messages', () {
    expect(
      featureErrorMessageKey('FEATURE_NOT_INCLUDED'),
      'features.errors.notIncluded',
    );
    expect(
      featureErrorMessageKey('AI_SUBSCRIPTION_INACTIVE'),
      'features.errors.notIncluded',
    );
    expect(
      featureErrorMessageKey('FEATURE_EXPIRED'),
      'features.errors.expired',
    );
    expect(
      featureErrorMessageKey('FEATURE_LIMIT_REACHED'),
      'features.errors.limitReached',
    );
    expect(
      featureErrorMessageKey('AI_SCHOOL_INACTIVE'),
      'features.errors.schoolInactive',
    );
    expect(
      featureErrorMessageKey('SCHOOL_SUSPENDED'),
      'features.errors.schoolInactive',
    );
    expect(
      featureErrorMessageKey('AI_SUBSCRIPTION_COVERED_BY_SCHOOL'),
      'features.errors.coveredBySchool',
    );
    expect(featureErrorMessageKey('AI_QUOTA_EXCEEDED'), isNull);
    expect(featureErrorMessageKey(null), isNull);
  });
}
