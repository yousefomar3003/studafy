import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/child_comparison_reports/child_comparison_reports_client.dart';
import 'package:studafy_mobile/src/core/api/generated/families/families_client.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_report_period.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_item.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_report.dart';
import 'package:studafy_mobile/src/core/api/generated/models/family.dart';
import 'package:studafy_mobile/src/core/api/generated/models/family_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification.dart' as api_models;
import 'package:studafy_mobile/src/core/api/generated/models/notification_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/core/api/generated/models/unread_count.dart';
import 'package:studafy_mobile/src/core/api/generated/models/unread_only.dart';
import 'package:studafy_mobile/src/core/api/generated/notifications/notifications_client.dart';
import 'package:studafy_mobile/src/core/api/generated/studafy_api_client.dart';
import 'package:studafy_mobile/src/features/parent/data/family_finance_client.dart';
import 'package:studafy_mobile/src/features/parent/domain/child_fees.dart';

// ---------------------------------------------------------------------------
// Model fixtures — built via fromJson (or public ctors) so a new field on a
// model doesn't silently break these.
// ---------------------------------------------------------------------------

const String _t0 = '2026-01-01T00:00:00.000Z';

Term termFixture({String id = 'term-1'}) => Term.fromJson({
      'id': id,
      'school_id': 'school-1',
      'academic_year_id': 'year-1',
      'code': 'T1',
      'name': 'Term 1',
      'sequence_number': 1,
      'starts_on': '2026-01-01',
      'ends_on': '2026-04-01',
      'status': 'active',
      'created_at': _t0,
      'updated_at': _t0,
    });

/// A child-comparison row. [absentPercent] / [absentCount] / [totalRecords] drive the
/// attendance alert; [termAverage] / [gpa] / [trendAverages] drive the grades card.
ChildComparisonItem childItem({
  required String id,
  required String name,
  int totalRecords = 40,
  int absentCount = 0,
  num absentPercent = 0,
  num? termAverage = 82,
  num? gpa = 3.1,
  List<num?> trendAverages = const [],
  String admissionNumber = 'ADM-1',
}) {
  return ChildComparisonItem.fromJson({
    'student_id': id,
    'student_name': name,
    'admission_number': admissionNumber,
    'grade': {
      'term_average_percentage': termAverage,
      'term_gpa': gpa,
      'total_credits': 12,
    },
    'grade_trend': [
      for (var i = 0; i < trendAverages.length; i++)
        {
          'term_id': 'term-$i',
          'term_name': 'Term $i',
          'term_average_percentage': trendAverages[i],
          'term_gpa': null,
        },
    ],
    'attendance': {
      'total_records': totalRecords,
      'present_count': totalRecords - absentCount,
      'absent_count': absentCount,
      'late_count': 0,
      'excused_count': 0,
      'present_percent': totalRecords == 0 ? 0 : 100 - absentPercent,
      'absent_percent': absentPercent,
      'late_percent': 0,
      'excused_percent': 0,
    },
    'assignments': {
      'total': 10,
      'submitted': 9,
      'on_time': 8,
      'late': 1,
      'completion_percent': 90,
    },
  });
}

ChildComparisonReport comparisonReport(List<ChildComparisonItem> children) {
  return ChildComparisonReport(
    generatedAt: DateTime.parse(_t0),
    period: AttendanceReportPeriod(
      termId: 'term-1',
      startDate: DateTime.parse('2026-01-01'),
      endDate: DateTime.parse('2026-04-01'),
    ),
    children: children,
  );
}

api_models.Notification notificationFixture({
  required String id,
  String title = 'Grade posted',
  String body = 'A new grade is available.',
  DateTime? createdAt,
  DateTime? readAt,
}) {
  final created = createdAt ?? DateTime.parse(_t0);
  return api_models.Notification.fromJson({
    'id': id,
    'school_id': 'school-1',
    'user_id': 'parent-1',
    'notification_type': 'GRADE_POSTED',
    'title': title,
    'body': body,
    'metadata': <String, Object?>{},
    'read_at': readAt?.toUtc().toIso8601String(),
    'created_at': created.toUtc().toIso8601String(),
    'updated_at': created.toUtc().toIso8601String(),
  });
}

Family familyFixture({String id = 'family-1'}) => Family(
      id: id,
      schoolId: 'school-1',
      displayName: 'The Ahmads',
      primaryParentUserId: 'parent-1',
      createdAt: DateTime.parse(_t0),
      updatedAt: DateTime.parse(_t0),
    );

MoneyTotal moneyTotal({String currency = 'JOD', required int minor, String? amount}) =>
    MoneyTotal(
      currency: currency,
      outstandingAmount: amount ?? (minor / 1000).toStringAsFixed(3),
      outstandingMinor: minor,
    );

// ---------------------------------------------------------------------------
// Fake domain clients — only the methods the parent providers call.
// ---------------------------------------------------------------------------

class FakeChildComparisonReportsClient extends Fake
    implements ChildComparisonReportsClient {
  FakeChildComparisonReportsClient(this._report);

  final ChildComparisonReport _report;
  String? lastTermId;

  @override
  Future<ChildComparisonReport> getChildrenComparison({required String termId}) async {
    lastTermId = termId;
    return _report;
  }
}

class FakeFamiliesClient extends Fake implements FamiliesClient {
  FakeFamiliesClient({this.families = const []});

  List<Family> families;

  @override
  Future<FamilyList> listFamilies({int? limit = 20, int? offset = 0, String? search}) async {
    return FamilyList(families: families, total: families.length);
  }
}

class FakeNotificationsClient extends Fake implements NotificationsClient {
  FakeNotificationsClient({this.notifications = const []});

  List<api_models.Notification> notifications;
  final List<String> markedRead = [];

  @override
  Future<NotificationList> listNotifications({
    String? cursor,
    UnreadOnly? unreadOnly,
    int? limit = 20,
  }) async {
    return NotificationList(notifications: notifications, nextCursor: null);
  }

  @override
  Future<UnreadCount> markNotificationRead({required String notificationId}) async {
    markedRead.add(notificationId);
    return const UnreadCount(unreadCount: 0);
  }
}

class FakeFamilyFinanceClient extends Fake implements FamilyFinanceClient {
  FakeFamilyFinanceClient(this._view);

  final FamilyFinanceView _view;
  final List<String> fetchedFamilyIds = [];

  @override
  Future<FamilyFinanceView> fetch(String familyId) async {
    fetchedFamilyIds.add(familyId);
    return _view;
  }
}

/// A [StudafyApiClient] whose parent-relevant getters return the fakes above; every other
/// getter throws (via [Fake]) so a test that reaches an unstubbed corner fails loudly.
class FakeStudafyApiClient extends Fake implements StudafyApiClient {
  FakeStudafyApiClient({
    FakeChildComparisonReportsClient? childComparisonReports,
    FakeFamiliesClient? families,
    FakeNotificationsClient? notifications,
  })  : childComparisonReports =
            childComparisonReports ?? FakeChildComparisonReportsClient(comparisonReport(const [])),
        families = families ?? FakeFamiliesClient(),
        notifications = notifications ?? FakeNotificationsClient();

  @override
  final FakeChildComparisonReportsClient childComparisonReports;
  @override
  final FakeFamiliesClient families;
  @override
  final FakeNotificationsClient notifications;
}
