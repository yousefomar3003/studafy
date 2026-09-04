import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/child_comparison_reports/child_comparison_reports_client.dart';
import 'package:studafy_mobile/src/core/api/generated/families/families_client.dart';
import 'package:studafy_mobile/src/core/api/generated/models/attendance_report_period.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_breakdown.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_item.dart';
import 'package:studafy_mobile/src/core/api/generated/models/child_comparison_report.dart';
import 'package:studafy_mobile/src/core/api/generated/models/family.dart';
import 'package:studafy_mobile/src/core/api/generated/models/family_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification.dart' as api_models;
import 'package:studafy_mobile/src/core/api/generated/models/notification_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/notification_preferences.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/core/api/generated/models/update_notification_preferences_request.dart';
import 'package:studafy_mobile/src/core/api/generated/models/unread_count.dart';
import 'package:studafy_mobile/src/core/api/generated/models/unread_only.dart';
import 'package:studafy_mobile/src/core/api/generated/notifications/notifications_client.dart';
import 'package:studafy_mobile/src/core/api/generated/studafy_api_client.dart';
import 'package:studafy_mobile/src/features/parent/data/family_finance_client.dart';
import 'package:studafy_mobile/src/features/parent/domain/family_finance.dart';

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

/// A single published-grade row, as the child breakdown endpoint returns it.
Map<String, Object?> gradeRowJson({
  required String id,
  required String courseId,
  required String courseName,
  String label = 'Quiz 1',
  num? score = 80,
  num maxScore = 100,
  num weight = 1,
  num? percentage = 80,
  String? gradeLabel = 'B',
  String publishedAt = '2026-02-01T00:00:00.000Z',
}) {
  return {
    'id': id,
    'grade_submission_id': 'sub-$id',
    'gradebook_id': 'gb-$courseId',
    'class': {'id': 'class-$courseId', 'code': '${courseName.toUpperCase()}-A'},
    'course': {
      'id': courseId,
      'code': courseId.toUpperCase(),
      'name': courseName,
      'credit_hours': 3,
    },
    'label': label,
    'score': score,
    'max_score': maxScore,
    'weight': weight,
    'percentage': percentage,
    'grade_label': gradeLabel,
    'gpa_points': 3,
    'published_at': publishedAt,
  };
}

/// One linked child's academic breakdown for a term. [gradeRows] feed the Grades tab;
/// [absentCount] / [absentPercent] / [totalRecords] drive the attendance totals and alert;
/// [assignmentsTotal] / [submitted] / [onTime] / [late] drive the Assignments tab.
ChildComparisonBreakdown childBreakdown({
  String id = 'child-1',
  String name = 'Amir',
  String admissionNumber = 'ADM-1',
  List<Map<String, Object?>> gradeRows = const [],
  num? termAverage = 82,
  num? termGpa = 3.1,
  num totalCredits = 12,
  List<num?> trendAverages = const [],
  int totalRecords = 40,
  int absentCount = 0,
  num absentPercent = 0,
  int lateCount = 0,
  int excusedCount = 0,
  List<num> weeklyPresentPercents = const [],
  int assignmentsTotal = 10,
  int submitted = 9,
  int onTime = 8,
  int late = 1,
}) {
  final presentCount = totalRecords - absentCount - lateCount - excusedCount;
  return ChildComparisonBreakdown.fromJson({
    'generated_at': _t0,
    'period': {
      'term_id': 'term-1',
      'start_date': '2026-01-01',
      'end_date': '2026-04-01',
    },
    'student': {
      'student_id': id,
      'student_name': name,
      'admission_number': admissionNumber,
    },
    'grade_trend': [
      for (var i = 0; i < trendAverages.length; i++)
        {
          'term_id': 'term-$i',
          'term_name': 'Term ${i + 1}',
          'term_average_percentage': trendAverages[i],
          'term_gpa': null,
        },
    ],
    'grade': {
      'grades': gradeRows,
      'term_summary': {
        'term_average_percentage': termAverage,
        'term_gpa': termGpa,
        'total_credits': totalCredits,
        'calculated_at': null,
      },
    },
    'attendance': {
      'totals': {
        'total_records': totalRecords,
        'present_count': presentCount,
        'absent_count': absentCount,
        'late_count': lateCount,
        'excused_count': excusedCount,
        'present_percent': totalRecords == 0 ? 0 : 100 - absentPercent,
        'absent_percent': absentPercent,
        'late_percent': 0,
        'excused_percent': 0,
      },
      'trends': [
        for (var i = 0; i < weeklyPresentPercents.length; i++)
          {
            'total_records': 5,
            'present_count': 5,
            'absent_count': 0,
            'late_count': 0,
            'excused_count': 0,
            'present_percent': weeklyPresentPercents[i],
            'absent_percent': 0,
            'late_percent': 0,
            'excused_percent': 0,
            'bucket_start': '2026-0${i + 1}-05T00:00:00.000Z',
          },
      ],
    },
    'assignments': {
      'total': assignmentsTotal,
      'submitted': submitted,
      'on_time': onTime,
      'late': late,
      'completion_percent': assignmentsTotal == 0
          ? 0
          : (submitted / assignmentsTotal * 100).round(),
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
  String notificationType = 'GRADE_POSTED',
  DateTime? createdAt,
  DateTime? readAt,
}) {
  final created = createdAt ?? DateTime.parse(_t0);
  return api_models.Notification.fromJson({
    'id': id,
    'school_id': 'school-1',
    'user_id': 'parent-1',
    'notification_type': notificationType,
    'title': title,
    'body': body,
    'metadata': <String, Object?>{},
    'read_at': readAt?.toUtc().toIso8601String(),
    'created_at': created.toUtc().toIso8601String(),
    'updated_at': created.toUtc().toIso8601String(),
  });
}

NotificationPreferences notificationPreferencesFixture({int? attendanceAlertThreshold}) {
  return NotificationPreferences(
    preferences: const [],
    attendanceAlertThreshold: attendanceAlertThreshold,
  );
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

FamilyInvoice familyInvoice({
  String docname = 'SI-0001',
  DateTime? issuedDate,
  DateTime? dueDate,
  String currency = 'JOD',
  required int outstandingMinor,
  int? totalMinor,
  String? payOnlineUrl,
}) {
  final total = totalMinor ?? outstandingMinor;
  return FamilyInvoice(
    erpnextDocname: docname,
    issuedDate: issuedDate ?? DateTime(2026, 1, 1),
    dueDate: dueDate,
    totalAmount: (total / 1000).toStringAsFixed(3),
    outstandingAmount: (outstandingMinor / 1000).toStringAsFixed(3),
    outstandingMinor: outstandingMinor,
    currency: currency,
    payOnlineUrl: payOnlineUrl,
  );
}

FamilyInstallment familyInstallment({
  String erpnextFeeScheduleId = 'FS-0001',
  DateTime? dueDate,
  String currency = 'JOD',
  required int outstandingMinor,
  int? totalMinor,
  InstallmentStatus status = InstallmentStatus.pending,
}) {
  final total = totalMinor ?? outstandingMinor;
  return FamilyInstallment(
    erpnextFeeScheduleId: erpnextFeeScheduleId,
    dueDate: dueDate ?? DateTime(2026, 2, 1),
    totalAmount: (total / 1000).toStringAsFixed(3),
    outstandingAmount: (outstandingMinor / 1000).toStringAsFixed(3),
    currency: currency,
    status: status,
  );
}

FamilyReceipt familyReceipt({
  String id = 'receipt-1',
  DateTime? paymentDate,
  String currency = 'JOD',
  required int amountMinor,
  ReceiptStatus status = ReceiptStatus.confirmed,
  String? receiptUrl,
}) {
  return FamilyReceipt(
    id: id,
    amount: (amountMinor / 1000).toStringAsFixed(3),
    currency: currency,
    status: status,
    receiptUrl: receiptUrl,
    paymentDate: paymentDate ?? DateTime(2026, 1, 15),
  );
}

FamilyStudentFinance financeSection({
  required String studentId,
  List<FamilyInvoice> invoices = const [],
  List<FamilyInstallment> installments = const [],
  List<FamilyReceipt> receipts = const [],
  List<MoneyTotal> totals = const [],
}) =>
    FamilyStudentFinance(
      studentId: studentId,
      invoices: invoices,
      installments: installments,
      receipts: receipts,
      totals: totals,
    );

// ---------------------------------------------------------------------------
// Fake domain clients — only the methods the parent providers call.
// ---------------------------------------------------------------------------

class FakeChildComparisonReportsClient extends Fake
    implements ChildComparisonReportsClient {
  FakeChildComparisonReportsClient(
    this._report, {
    this.breakdowns = const {},
  });


  final ChildComparisonReport _report;
  final Map<String, ChildComparisonBreakdown> breakdowns;
  String? lastTermId;
  String? lastBreakdownStudentId;

  @override
  Future<ChildComparisonReport> getChildrenComparison({required String termId}) async {
    lastTermId = termId;
    return _report;
  }

  @override
  Future<ChildComparisonBreakdown> getChildComparisonBreakdown({
    required String studentId,
    required String termId,
  }) async {
    lastTermId = termId;
    lastBreakdownStudentId = studentId;
    final breakdown = breakdowns[studentId];
    if (breakdown == null) {
      throw StateError('no breakdown fixture for $studentId');
    }
    return breakdown;
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
  FakeNotificationsClient({
    this.notifications = const [],
    NotificationPreferences? preferences,
  }) : preferences = preferences ?? notificationPreferencesFixture();

  List<api_models.Notification> notifications;
  NotificationPreferences preferences;
  final List<String> markedRead = [];
  int? lastThresholdUpdate;
  bool lastThresholdUpdateCleared = false;

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

  @override
  Future<NotificationPreferences> getNotificationPreferences() async {
    return preferences;
  }

  @override
  Future<NotificationPreferences> updateNotificationPreferences({
    required UpdateNotificationPreferencesRequest body,
  }) async {
    lastThresholdUpdate = body.attendanceAlertThreshold;
    lastThresholdUpdateCleared = body.attendanceAlertThreshold == null;
    preferences = notificationPreferencesFixture(
      attendanceAlertThreshold: body.attendanceAlertThreshold,
    );
    return preferences;
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
