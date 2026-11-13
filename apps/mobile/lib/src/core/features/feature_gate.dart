import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/widgets.dart';

import 'my_features.dart';

/// What a paid screen or entry point shows for one feature, decided from the person's
/// `GET /api/me/features` verdict (`docs/billing/feature-licensing.md`, session 6). One state per
/// case the gate must tell apart; [featureGateStateOf] is the only place they are decided, so the
/// rules below are tested once and every screen agrees:
///
///   - covered personally, by a school seat, or by both (then the personal renewal is off);
///     a covered feature may have used up this month's limit;
///   - not covered, and the school sells a seat that includes it (or the person already holds a
///     seat): ask the school -- never a purchase;
///   - not covered, no school seat on offer: the store purchase;
///   - the school is inactive, or Studafy paused the feature.
///
/// A person holding a school seat is never in [FeaturePurchasable] (App Store / Google Play rules:
/// what a school provides is not sold to its users in the app).
sealed class FeatureGateState {
  const FeatureGateState();
}

/// Who pays for a covered feature.
enum FeatureCoverage { personal, school, both }

class FeatureCovered extends FeatureGateState {
  const FeatureCovered({
    required this.coverage,
    required this.schoolName,
    required this.used,
    required this.limit,
    required this.limitReached,
    required this.resetsOn,
    this.personalEndsAt,
    this.renewalStop,
  });

  final FeatureCoverage coverage;
  final String schoolName;
  final int used;

  /// Units a month; null is unlimited (or the feature counts nothing).
  final int? limit;

  /// This month's units are used up: the feature is still theirs, the next use is refused.
  final bool limitReached;

  /// When usage resets: the 1st of next month, UTC.
  final DateTime resetsOn;

  /// [FeatureCoverage.both]: when the personal subscription ends (it does not renew).
  final DateTime? personalEndsAt;

  /// [FeatureCoverage.both]: the renewal the seat turned off.
  final FeatureRenewalStop? renewalStop;

  /// The App Store does not let Studafy turn renewal off: the person must, in their Apple ID.
  bool get mustTurnOffAppStoreRenewal =>
      coverage == FeatureCoverage.both &&
      (renewalStop?.userMustTurnOffRenewal ?? false);
}

/// Not covered, but the school provides it: "Ask your school for a seat". [hasSeat] is a person
/// who already holds a seat whose tier does not include this feature.
class FeatureAskSchool extends FeatureGateState {
  const FeatureAskSchool({required this.schoolName, required this.hasSeat});

  final String schoolName;
  final bool hasSeat;
}

/// Not covered and nothing from the school: the existing store purchase / paywall.
class FeaturePurchasable extends FeatureGateState {
  const FeaturePurchasable({this.expiredOn});

  /// When the person's own access ended, for "Your access ended on …"; null if they never had it.
  final DateTime? expiredOn;
}

class FeatureSchoolInactive extends FeatureGateState {
  const FeatureSchoolInactive();
}

/// Studafy switched the feature off for everyone for now, or it is not offered at all.
class FeatureUnavailable extends FeatureGateState {
  const FeatureUnavailable();
}

/// The 1st of the month after [now], UTC: when monthly usage resets (server rule).
DateTime usageResetsOn(DateTime now) {
  final utc = now.toUtc();
  return DateTime.utc(utc.year, utc.month + 1);
}

/// Decides [FeatureGateState] for [key]. A feature missing from the list (hidden and not held) is
/// [FeatureUnavailable].
FeatureGateState featureGateStateOf(
  MyFeatures features,
  String key, {
  DateTime? now,
}) {
  final feature = features[key];
  if (feature == null) return const FeatureUnavailable();
  final clock = now ?? DateTime.now();

  switch (feature.reason) {
    case FeatureReason.schoolInactive:
      return const FeatureSchoolInactive();
    case FeatureReason.paused:
      return const FeatureUnavailable();
    case null ||
        FeatureReason.limitReached ||
        FeatureReason.notIncluded ||
        FeatureReason.expired:
      break;
  }

  if (feature.active) {
    final school = feature.sources.any(
      (s) => s.source == FeatureGrantSource.schoolLicense,
    );
    final personal = feature.sources.where((s) => s.source.isPersonal).toList();
    final coverage = school && personal.isNotEmpty
        ? FeatureCoverage.both
        : school
        ? FeatureCoverage.school
        : FeatureCoverage.personal;
    DateTime? personalEndsAt;
    for (final grant in personal) {
      if (personalEndsAt == null || grant.periodEnd.isAfter(personalEndsAt)) {
        personalEndsAt = grant.periodEnd;
      }
    }
    return FeatureCovered(
      coverage: coverage,
      schoolName: features.schoolName,
      used: feature.used,
      limit: feature.unit == null ? null : feature.limit,
      limitReached: feature.reason == FeatureReason.limitReached,
      resetsOn: usageResetsOn(clock),
      personalEndsAt: coverage == FeatureCoverage.both ? personalEndsAt : null,
      renewalStop: coverage == FeatureCoverage.both
          ? feature.renewalStop
          : null,
    );
  }

  if (feature.schoolSeat || feature.schoolOffers) {
    return FeatureAskSchool(
      schoolName: features.schoolName,
      hasSeat: feature.schoolSeat,
    );
  }
  return FeaturePurchasable(
    expiredOn: feature.reason == FeatureReason.expired
        ? feature.periodEnd
        : null,
  );
}

/// The translation key of a friendly message for an API refusal of a paid feature, or null for a
/// code that is not one. The AI routes still answer their legacy `AI_*` codes until the minimum app
/// version reads `FEATURE_*` (docs/billing/feature-licensing.md, session 1, decision 7); both map.
String? featureErrorMessageKey(String? code) => switch (code) {
  'FEATURE_NOT_INCLUDED' ||
  'AI_SUBSCRIPTION_INACTIVE' => 'features.errors.notIncluded',
  'FEATURE_EXPIRED' => 'features.errors.expired',
  'FEATURE_LIMIT_REACHED' => 'features.errors.limitReached',
  'AI_SCHOOL_INACTIVE' ||
  'SCHOOL_SUSPENDED' => 'features.errors.schoolInactive',
  'AI_SUBSCRIPTION_COVERED_BY_SCHOOL' => 'features.errors.coveredBySchool',
  _ => null,
};

/// "Monthly limit reached, resets on (date)" for a refused use of a feature, in [context]'s locale.
String featureLimitReachedMessage(BuildContext context, {DateTime? now}) =>
    'features.errors.limitReached'.tr(
      namedArgs: {
        'date': DateFormat.yMMMd(
          context.locale.toString(),
        ).format(usageResetsOn(now ?? DateTime.now())),
      },
    );
