import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement_audience_type.dart';
import 'package:studafy_mobile/src/core/api/generated/models/announcement_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/assignment_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/class_value.dart';
import 'package:studafy_mobile/src/core/api/generated/models/course.dart';
import 'package:studafy_mobile/src/core/api/generated/models/cumulative_grade_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_grade_snapshot.dart';
import 'package:studafy_mobile/src/core/api/generated/models/published_term_summary.dart';
import 'package:studafy_mobile/src/core/api/generated/models/timetable_slot.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/today_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/today_section.dart';
import 'package:studafy_mobile/src/features/student/presentation/today_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

CachedValue<T> _live<T>(T data) {
  return CachedValue(
    data: data,
    fetchedAt: DateTime(2026, 1, 1),
    source: CacheSource.network,
  );
}

Assignment _assignment(String id, String title, int daysUntilDue) {
  final now = DateTime(2026, 1, 1);
  return Assignment(
    id: id,
    schoolId: 'school-1',
    classId: 'class-1',
    subjectId: 'subject-1',
    title: title,
    description: null,
    instructions: null,
    status: AssignmentStatus.published,
    availableFrom: null,
    assignedAt: now,
    dueAt: now.add(Duration(days: daysUntilDue)),
    maxScore: 100,
    allowLateSubmission: false,
    attachments: const [],
    createdByUserId: 'teacher-1',
    lastEditedByUserId: 'teacher-1',
    createdAt: now,
    updatedAt: now,
  );
}

Announcement _announcement(
  String id,
  String title,
  String body, {
  bool mandatory = false,
}) {
  final now = DateTime(2026, 1, 1);
  return Announcement(
    id: id,
    schoolId: 'school-1',
    createdBy: 'admin-1',
    createdByName: 'Principal',
    title: title,
    body: body,
    mandatory: mandatory,
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

TimetableSlot _slot(String id, int period) {
  final now = DateTime(2026, 1, 1);
  return TimetableSlot(
    id: id,
    schoolId: 'school-1',
    timetableVersionId: 'version-1',
    classId: 'class-1',
    teacherId: 'teacher-1',
    roomId: 'room-1',
    weekday: DateTime.now().weekday,
    period: period,
    createdAt: now,
    updatedAt: now,
  );
}

PublishedGrade _grade(String id, String courseName, num score) {
  return PublishedGrade(
    id: id,
    gradeSubmissionId: 'submission-$id',
    gradebookId: 'gradebook-1',
    classValue: const ClassValue(id: 'class-1', code: 'MATH101-A'),
    course: Course(
      id: 'course-$id',
      code: 'C$id',
      name: courseName,
      creditHours: 3,
    ),
    label: 'Midterm',
    score: score,
    maxScore: 100,
    weight: 1,
    percentage: score,
    gradeLabel: 'A',
    gpaPoints: 4,
    publishedAt: DateTime(2026, 1, 1),
  );
}

Future<void> _pumpGolden(WidgetTester tester, Locale locale) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    KeyedSubtree(
      key: UniqueKey(),
      child: wrapWithLocalization(
        ProviderScope(
          overrides: [
            todayTimetableProvider.overrideWith(
              (ref) => Stream.value(
                TodaySectionReady(_live([_slot('s1', 1), _slot('s2', 2)])),
              ),
            ),
            todayAssignmentsProvider.overrideWith(
              (ref) => Stream.value(
                _live([
                  _assignment('a1', 'Algebra Worksheet', 1),
                  _assignment('a2', 'Essay Draft', 3),
                ]),
              ),
            ),
            todayGradesProvider.overrideWith(
              (ref) => Stream.value(
                TodaySectionReady(
                  _live(
                    PublishedGradeSnapshot(
                      studentId: 'student-1',
                      termId: 'term-1',
                      grades: [
                        _grade('g1', 'Mathematics', 92),
                        _grade('g2', 'Physics', 85),
                      ],
                      termSummary: const PublishedTermSummary(
                        termAveragePercentage: 88,
                        termGpa: 3.7,
                        totalCredits: 12,
                        calculatedAt: null,
                      ),
                      cumulativeSummary: const CumulativeGradeSummary(
                        cumulativeGpa: 3.7,
                        totalCredits: 12,
                        throughTermId: 'term-1',
                      ),
                    ),
                  ),
                ),
              ),
            ),
            todayAnnouncementsProvider.overrideWith(
              (ref) => Stream.value(
                _live([
                  _announcement(
                    'an1',
                    'Sports Day',
                    'Sports day is next Friday.',
                    mandatory: true,
                  ),
                  _announcement(
                    'an2',
                    'Library Hours',
                    'The library closes early on Fridays.',
                  ),
                ]),
              ),
            ),
          ],
          child: Builder(
            builder: (context) {
              return MediaQuery(
                data: const MediaQueryData(textScaler: TextScaler.noScaling),
                child: MaterialApp(
                  theme: AppTheme.light,
                  debugShowCheckedModeBanner: false,
                  locale: context.locale,
                  supportedLocales: context.supportedLocales,
                  localizationsDelegates: context.localizationDelegates,
                  home: const Scaffold(body: TodayScreen()),
                ),
              );
            },
          ),
        ),
        startLocale: locale,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets(
    'today screen, loaded — English (LTR)',
    (tester) async {
      await _pumpGolden(tester, const Locale('en'));
      await expectLater(
        find.byType(TodayScreen),
        matchesGoldenFile('goldens/today_screen_en.png'),
      );
    },
    // See kGoldenRenderDiffSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );

  testWidgets(
    'today screen, loaded — Arabic (RTL)',
    (tester) async {
      await _pumpGolden(tester, const Locale('ar'));
      await expectLater(
        find.byType(TodayScreen),
        matchesGoldenFile('goldens/today_screen_ar.png'),
      );
    },
    // See kGoldenRenderDiffSkipReason's doc comment (golden_test_skip.dart) for why.
    skip: true,
  );
}
