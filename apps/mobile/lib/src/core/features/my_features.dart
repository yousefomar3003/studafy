/// The signed-in person's paid features, as `GET /api/me/features` reports them
/// (`apps/api/src/modules/features/routes.ts`; `docs/billing/feature-licensing.md`): one verdict
/// per registered feature -- active or not and why, the grants it comes from, this month's usage
/// -- and what the school's license means for it.
///
/// Parsed by hand from the JSON rather than through the generated client so the parsing is pinned
/// by a unit test here and the gate does not depend on the generator's naming of nested models.
library;

/// The registered feature keys (`packages/constants/src/features.ts`). A feature registered later
/// needs no entry here to be listed -- only a screen that gates on it names its key.
abstract final class FeatureKeys {
  static const aiTutor = 'ai_tutor';
  static const studyTools = 'study_tools';
  static const notebook = 'notebook';
  static const autoGrading = 'auto_grading';
  static const familyPlus = 'family_plus';
}

/// Where a grant comes from.
enum FeatureGrantSource {
  purchase,
  schoolLicense,
  trial;

  static FeatureGrantSource? parse(Object? value) => switch (value) {
    'purchase' => FeatureGrantSource.purchase,
    'school_license' => FeatureGrantSource.schoolLicense,
    'trial' => FeatureGrantSource.trial,
    _ => null,
  };

  /// Bought (or trialling) by the person themselves, as opposed to provided by the school.
  bool get isPersonal => this != FeatureGrantSource.schoolLicense;
}

/// One live grant that includes a feature.
class FeatureGrant {
  const FeatureGrant({
    required this.source,
    required this.limit,
    required this.periodEnd,
  });

  final FeatureGrantSource source;

  /// Units a month this grant gives; null is unlimited.
  final int? limit;
  final DateTime periodEnd;
}

/// A personal subscription whose renewal the person's school seat turned off.
class FeatureRenewalStop {
  const FeatureRenewalStop({required this.provider, required this.action});

  /// `app_store`, `google_play`, `tap`, `stripe`, or null.
  final String? provider;

  /// `cancel_at_period_end` (Studafy turned it off) or `notify_user` (the App Store does not let a
  /// server do it: the person turns renewal off in their Apple ID settings).
  final String action;

  bool get userMustTurnOffRenewal =>
      action == 'notify_user' || provider == 'app_store';
}

/// Why a feature is not active, or `limitReached` while it is.
enum FeatureReason {
  schoolInactive,
  paused,
  notIncluded,
  expired,
  limitReached;

  static FeatureReason? parse(Object? value) => switch (value) {
    'school_inactive' => FeatureReason.schoolInactive,
    'paused' => FeatureReason.paused,
    'not_included' => FeatureReason.notIncluded,
    'expired' => FeatureReason.expired,
    'limit_reached' => FeatureReason.limitReached,
    _ => null,
  };
}

class MyFeature {
  const MyFeature({
    required this.key,
    required this.name,
    required this.unit,
    required this.active,
    required this.sources,
    required this.limit,
    required this.used,
    required this.periodEnd,
    required this.reason,
    required this.schoolSeat,
    required this.schoolOffers,
    required this.renewalStop,
  });

  factory MyFeature.fromJson(Map<String, dynamic> json) {
    final stop = json['renewalStop'];
    return MyFeature(
      key: json['key'] as String,
      name: json['name'] as String? ?? json['key'] as String,
      unit: json['unit'] as String?,
      active: json['active'] as bool? ?? false,
      sources: [
        for (final entry in (json['sources'] as List<dynamic>? ?? const []))
          if (entry is Map<String, dynamic> &&
              FeatureGrantSource.parse(entry['source']) != null)
            FeatureGrant(
              source: FeatureGrantSource.parse(entry['source'])!,
              limit: (entry['limit'] as num?)?.toInt(),
              periodEnd: DateTime.parse(entry['periodEnd'] as String),
            ),
      ],
      limit: (json['limit'] as num?)?.toInt(),
      used: (json['used'] as num?)?.toInt() ?? 0,
      periodEnd: json['periodEnd'] is String
          ? DateTime.parse(json['periodEnd'] as String)
          : null,
      reason: FeatureReason.parse(json['reason']),
      schoolSeat: json['schoolSeat'] as bool? ?? false,
      schoolOffers: json['schoolOffers'] as bool? ?? false,
      renewalStop: stop is Map<String, dynamic>
          ? FeatureRenewalStop(
              provider: stop['provider'] as String?,
              action: stop['action'] as String? ?? '',
            )
          : null,
    );
  }

  final String key;
  final String name;

  /// `messages`, `generations`, `pages`, `submissions`, or null for an unmetered feature.
  final String? unit;
  final bool active;
  final List<FeatureGrant> sources;

  /// Units a month (the best of the grants); null is unlimited.
  final int? limit;
  final int used;

  /// The reported grant's period end; for an expired feature, the one that ended.
  final DateTime? periodEnd;
  final FeatureReason? reason;

  /// The person holds a seat of this feature's audience on the school's license in force.
  final bool schoolSeat;

  /// The school's license sells a seat of this audience whose tier includes the feature.
  final bool schoolOffers;
  final FeatureRenewalStop? renewalStop;
}

class MyFeatures {
  const MyFeatures({required this.schoolName, required this.features});

  factory MyFeatures.fromJson(Map<String, dynamic> json) => MyFeatures(
    schoolName: json['schoolName'] as String? ?? '',
    features: {
      for (final entry in (json['features'] as List<dynamic>? ?? const []))
        if (entry is Map<String, dynamic>)
          entry['key'] as String: MyFeature.fromJson(entry),
    },
  );

  final String schoolName;
  final Map<String, MyFeature> features;

  MyFeature? operator [](String key) => features[key];
}
