import 'package:studafy_mobile/src/core/features/my_features.dart';

/// `GET /api/me/features` JSON for the gate's tests, shaped exactly as the API sends it.
Map<String, dynamic> featureJson({
  String key = FeatureKeys.aiTutor,
  String? unit = 'messages',
  bool active = false,
  List<Map<String, dynamic>> sources = const [],
  int? limit,
  int used = 0,
  String? periodEnd,
  String? reason,
  bool schoolSeat = false,
  bool schoolOffers = false,
  Map<String, dynamic>? renewalStop,
}) => {
  'key': key,
  'name': 'AI tutor',
  'nameKey': 'features.$key.name',
  'audience': 'student',
  'unit': unit,
  'active': active,
  'source': sources.isEmpty ? null : sources.first['source'],
  'sources': sources,
  'limit': limit,
  'used': used,
  'periodEnd':
      periodEnd ?? (sources.isEmpty ? null : sources.first['periodEnd']),
  'reason': reason,
  'schoolSeat': schoolSeat,
  'schoolOffers': schoolOffers,
  'renewalStop': renewalStop,
};

Map<String, dynamic> grant(
  String source, {
  int? limit,
  String periodEnd = '2027-08-31T00:00:00.000Z',
}) => {
  'source': source,
  'tier': 'student_plus',
  'limit': limit,
  'periodEnd': periodEnd,
};

MyFeatures featuresFrom(
  List<Map<String, dynamic>> features, {
  String school = 'Alpha Academy',
}) => MyFeatures.fromJson({'schoolName': school, 'features': features});
