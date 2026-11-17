import 'package:studafy_mobile/src/features/parent/domain/student_ai_offer.dart';

/// `GET /api/parent/student-ai` fixtures, as JSON so the hand-written parsing is exercised too.

const studentAiTermsVersion = 'ai-optin-2026-11';

StudentAiOffers offersOf(List<Map<String, Object?>> offers) =>
    StudentAiOffers.fromJson({'offers': offers, 'termsVersion': studentAiTermsVersion});

Map<String, Object?> _window() => {
  'id': 'window-1',
  'opensOn': '2026-09-01',
  'closesOn': '2026-12-15',
  'academicYearName': '2026/2027',
};

Map<String, Object?> availableOfferJson({
  required String id,
  required String name,
  int monthly = 600,
  int months = 8,
  String startMonth = '2026-09-01',
  String endMonth = '2027-04-01',
}) => {
  'studentId': id,
  'studentName': name,
  'state': 'available',
  'window': _window(),
  'pricing': {
    'currencyCode': 'USD',
    'minorUnit': 2,
    'monthlyPriceMinor': monthly,
    'months': months,
    'totalMinor': monthly * months,
    'startMonth': startMonth,
    'endMonth': endMonth,
  },
  'optIn': null,
};

Map<String, Object?> closedOfferJson({required String id, required String name}) => {
  'studentId': id,
  'studentName': name,
  'state': 'closed',
  'window': null,
  'pricing': null,
  'optIn': null,
};

Map<String, Object?> optInJson({
  required String studentId,
  String name = 'Amir',
  int monthly = 600,
  int months = 8,
  String source = 'parent',
  String? seatId = 'seat-1',
  String status = 'active',
  String? releasedEffectiveMonth,
}) => {
  'id': 'optin-$studentId',
  'studentId': studentId,
  'studentName': name,
  'academicYearId': 'year-1',
  'licenseId': 'license-1',
  'windowId': 'window-1',
  'source': source,
  'parent': source == 'parent' ? {'userId': 'parent-1', 'name': 'Test Parent'} : null,
  'recordedBy': {'userId': 'parent-1', 'name': 'Test Parent'},
  'note': null,
  'termsVersion': studentAiTermsVersion,
  'optedInAt': '2026-09-03T10:00:00.000Z',
  'startMonth': '2026-09-01',
  'endMonth': '2027-04-01',
  'months': months,
  'currencyCode': 'USD',
  'minorUnit': 2,
  'monthlyPriceMinor': monthly,
  'totalMinor': monthly * months,
  'seatId': seatId,
  'seatAssignedAt': seatId == null ? null : '2026-09-04T10:00:00.000Z',
  'status': status,
  'endedAt': status == 'active' ? null : '2026-12-20T10:00:00.000Z',
  'endNote': null,
  'releasedEffectiveMonth': releasedEffectiveMonth,
  'transferredToId': null,
  'transferredFromId': null,
};

Map<String, Object?> optedInOfferJson({
  required String id,
  required String name,
  int monthly = 600,
  int months = 8,
  String source = 'parent',
  String? seatId = 'seat-1',
  String status = 'active',
  String? releasedEffectiveMonth,
}) => {
  'studentId': id,
  'studentName': name,
  'state': 'opted_in',
  'window': null,
  'pricing': null,
  'optIn': optInJson(
    studentId: id,
    name: name,
    monthly: monthly,
    months: months,
    source: source,
    seatId: seatId,
    status: status,
    releasedEffectiveMonth: releasedEffectiveMonth,
  ),
};
