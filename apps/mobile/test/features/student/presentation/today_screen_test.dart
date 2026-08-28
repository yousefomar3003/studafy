import 'dart:async';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement_audience_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/cumulative_grade_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade_snapshot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_term_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/today_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/today_section.dart';
import 'package:studafy_mobile/src/features/student/presentation/today_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/today_skeleton.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/today_state_message.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Assignment _fakeAssignment() {
  final now = DateTime(2026, 1, 1);
  return Assignment(
    id: 'assignment-1',
    schoolId: 'school-1',
    classId: 'class-1',
    subjectId: 'subject-1',
    title: 'Algebra Worksheet',
    description: null,
    instructions: null,
    status: AssignmentStatus.published,
    availableFrom: null,
    assignedAt: now,
    dueAt: now.add(const Duration(days: 2)),
    maxScore: 100,
    allowLateSubmission: false,
    attachments: const [],
    createdByUserId: 'teacher-1',
    lastEditedByUserId: 'teacher-1',
    createdAt: now,
    updatedAt: now,
  );
}

Announcement _fakeAnnouncement() {
  final now = DateTime(2026, 1, 1);
  return Announcement(
    id: 'announcement-1',
    schoolId: 'school-1',
    createdBy: 'admin-1',
    createdByName: 'Principal',
    title: 'Sports Day',
    body: 'Sports day is next Friday.',
    mandatory: false,
    audienceType: AnnouncementAudienceType.school,
    audienceRole: null,
    audienceClassId: null,
    audienceClassCode: null,
    status: AnnouncementStatus.published,
    scheduledAt: now,
    publishedAt: now,
    recipientCount: 10,
    notifiedCount: 10,
    createdAt: now,
    updatedAt: now,
  );
}

TimetableSlot _fakeSlot() {
  final now = DateTime(2026, 1, 1);
  return TimetableSlot(
    id: 'slot-1',
    schoolId: 'school-1',
    timetableVersionId: 'version-1',
    classId: 'class-1',
    teacherId: 'teacher-1',
    roomId: 'room-1',
    weekday: DateTime.now().weekday,
    period: 1,
    createdAt: now,
    updatedAt: now,
  );
}

CachedValue<T> _live<T>(T data) {
  return CachedValue(data: data, fetchedAt: DateTime.now(), source: CacheSource.network);
}

/// Takes the already-built [scope] rather than a raw overrides list — riverpod 3.3.2's
/// `flutter_riverpod.dart` barrel doesn't export the `Override` type its own
/// `ProviderScope.overrides` is typed with, so a test helper can't name `List<Override>` itself;
/// building the scope (with [TodayScreen] already inside it) at each call site sidesteps that.
Future<void> _pumpTodayScreen(WidgetTester tester, ProviderScope scope) async {
  await tester.pumpWidget(wrapWithLocalization(scope));
}

Widget _todayScreenScope() {
  // `locale`/`supportedLocales`/`localizationsDelegates` must come from `context.locale` etc. (a
  // descendant of the `EasyLocalization` `wrapWithLocalization` mounts above this) — without
  // them, `.tr()` silently falls back to returning the raw key, same wiring
  // `test/support/pump_app_shell.dart` uses for the same reason.
  return Builder(
    builder: (context) {
      return MaterialApp(
        theme: AppTheme.light,
        debugShowCheckedModeBanner: false,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        home: const Scaffold(body: TodayScreen()),
      );
    },
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows a skeleton per card while every data source is still loading', (
    tester,
  ) async {
    // Broadcast, not single-subscription: all four provider overrides below listen to the same
    // stream, and a plain `StreamController` only allows one listener.
    final never = StreamController<Never>.broadcast();
    addTearDown(never.close);

    await _pumpTodayScreen(
      tester,
      ProviderScope(
        overrides: [
          todayTimetableProvider.overrideWith((ref) => never.stream),
          todayAssignmentsProvider.overrideWith((ref) => never.stream),
          todayGradesProvider.overrideWith((ref) => never.stream),
          todayAnnouncementsProvider.overrideWith((ref) => never.stream),
        ],
        child: _todayScreenScope(),
      ),
    );
    // No pumpAndSettle: these providers never resolve, by design.
    await tester.pump();

    expect(find.byType(TodaySkeleton), findsNWidgets(4));
  });

  testWidgets('renders each card once its own data source resolves', (tester) async {
    await _pumpTodayScreen(
      tester,
      ProviderScope(
        overrides: [
          todayTimetableProvider.overrideWith(
            (ref) => Stream.value(TodaySectionReady(_live([_fakeSlot()]))),
          ),
          todayAssignmentsProvider.overrideWith(
            (ref) => Stream.value(_live([_fakeAssignment()])),
          ),
          todayGradesProvider.overrideWith(
            (ref) => Stream.value(
              TodaySectionReady(
                _live(
                  PublishedGradeSnapshot(
                    studentId: 'student-1',
                    termId: 'term-1',
                    grades: const [],
                    termSummary: const PublishedTermSummary(
                      termAveragePercentage: null,
                      termGpa: null,
                      totalCredits: 0,
                      calculatedAt: null,
                    ),
                    cumulativeSummary: const CumulativeGradeSummary(
                      cumulativeGpa: null,
                      totalCredits: 0,
                      throughTermId: 'term-1',
                    ),
                  ),
                ),
              ),
            ),
          ),
          todayAnnouncementsProvider.overrideWith(
            (ref) => Stream.value(_live([_fakeAnnouncement()])),
          ),
        ],
        child: _todayScreenScope(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(TodaySkeleton), findsNothing);
    expect(find.text('Algebra Worksheet'), findsOneWidget);
    expect(find.text('Sports Day'), findsOneWidget);
    // No grades were published, so the grades card falls back to its empty state.
    expect(find.text('No grades published yet this term.'), findsOneWidget);
  });

  testWidgets('shows the unavailable message for grades and timetable when their context is unresolved', (
    tester,
  ) async {
    await _pumpTodayScreen(
      tester,
      ProviderScope(
        overrides: [
          todayTimetableProvider.overrideWith(
            (ref) => Stream.value(const TodaySectionUnavailable()),
          ),
          todayAssignmentsProvider.overrideWith((ref) => Stream.value(_live(const []))),
          todayGradesProvider.overrideWith(
            (ref) => Stream.value(const TodaySectionUnavailable()),
          ),
          todayAnnouncementsProvider.overrideWith((ref) => Stream.value(_live(const []))),
        ],
        child: _todayScreenScope(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(TodayStateMessage), findsNWidgets(4));
    expect(find.text("Today's timetable isn't available yet."), findsOneWidget);
    expect(find.text("Grades aren't available yet."), findsOneWidget);
  });
}
