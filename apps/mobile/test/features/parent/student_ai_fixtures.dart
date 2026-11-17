import 'package:studafy_mobile/src/features/parent/domain/student_ai_offer.dart';

/// `GET /api/parent/student-ai` fixtures, as JSON so the hand-written parsing is exercised too.
/// Shaped like the API's parent responses: no price, total, amount or currency anywhere (the
/// school tells parents the price).

const studentAiTermsVersion = 'ai-optin-2026-11';

StudentAiOffers offersOf(List<Map<String, Object?>> offers, {String? termsVersion}) =>
    StudentAiOffers.fromJson({
      'schoolName': 'Alpha Academy',
      'offers': offers,
      'termsVersion': termsVersion ?? studentAiTermsVersion,
    });

Map<String, Object?> _window() => {
  'id': 'window-1',
  'opensOn': '2026-09-01',
  'closesOn': '2026-12-15',
  'academicYearName': '2026/2027',
};

Map<String, Object?> availableOfferJson({
  required String id,
  required String name,
  String startMonth = '2026-09-01',
  String endMonth = '2027-04-01',
}) => {
  'studentId': id,
  'studentName': name,
  'state': 'available',
  'window': _window(),
  'period': {'startMonth': startMonth, 'endMonth': endMonth},
  'optIn': null,
};

Map<String, Object?> closedOfferJson({required String id, required String name}) => {
  'studentId': id,
  'studentName': name,
  'state': 'closed',
  'window': null,
  'period': null,
  'optIn': null,
};

Map<String, Object?> optInJson({
  required String studentId,
  String name = 'Amir',
  String source = 'parent',
  bool waitingForSchool = false,
  String status = 'active',
  String startMonth = '2026-09-01',
  String? releasedEffectiveMonth,
}) => {
  'id': 'optin-$studentId',
  'studentId': studentId,
  'studentName': name,
  'source': source,
  'termsVersion': studentAiTermsVersion,
  'optedInAt': '2026-09-03T10:00:00.000Z',
  'startMonth': startMonth,
  'endMonth': '2027-04-01',
  'status': status,
  'waitingForSchool': waitingForSchool,
  'releasedEffectiveMonth': releasedEffectiveMonth,
};

Map<String, Object?> optedInOfferJson({
  required String id,
  required String name,
  String source = 'parent',
  bool waitingForSchool = false,
  String status = 'active',
  String startMonth = '2026-09-01',
  String? releasedEffectiveMonth,
}) => {
  'studentId': id,
  'studentName': name,
  'state': 'opted_in',
  'window': null,
  'period': null,
  'optIn': optInJson(
    studentId: id,
    name: name,
    source: source,
    waitingForSchool: waitingForSchool,
    status: status,
    startMonth: startMonth,
    releasedEffectiveMonth: releasedEffectiveMonth,
  ),
};
