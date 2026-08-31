import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart' hide Material;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/exam.dart';
import 'package:studafy_mobile/src/core/api/generated/models/material.dart';
import 'package:studafy_mobile/src/core/offline/cached_value.dart';
import 'package:studafy_mobile/src/core/offline/staleness_banner.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/student/application/exams_providers.dart';
import 'package:studafy_mobile/src/features/student/application/materials_providers.dart';
import 'package:studafy_mobile/src/features/student/domain/upcoming_exams.dart';
import 'package:studafy_mobile/src/features/student/presentation/exams_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/materials_screen.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/exam_card.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/exam_day_section.dart';
import 'package:studafy_mobile/src/features/student/presentation/widgets/exams_placeholders.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';

Exam _exam({
  required String id,
  required String title,
  required DateTime startsAt,
  String? roomId,
  num weight = 20,
}) {
  return Exam.fromJson({
    'id': id,
    'school_id': 'school-1',
    'class_id': 'class-1',
    'created_by_user_id': 'user-1',
    'last_edited_by_user_id': 'user-1',
    'title': title,
    'description': null,
    'status': 'scheduled',
    'starts_at': startsAt.toUtc().toIso8601String(),
    'ends_at': startsAt.add(const Duration(hours: 1)).toUtc().toIso8601String(),
    'max_score': 100,
    'room_id': roomId,
    'weight': weight,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

CachedValue<ExamsAgenda> _agenda({required bool stale}) {
  return CachedValue(
    data: ExamsAgenda(
      days: [
        ExamDay(
          date: DateTime(2026, 9, 2),
          exams: [
            _exam(
              id: 'e1',
              title: 'Algebra Midterm',
              startsAt: DateTime(2026, 9, 2, 9),
              roomId: 'room-1',
            ),
          ],
        ),
        ExamDay(
          date: DateTime(2026, 9, 5),
          exams: [_exam(id: 'e2', title: 'Biology Quiz', startsAt: DateTime(2026, 9, 5, 11))],
        ),
      ],
    ),
    fetchedAt: DateTime(2026, 9, 1, 8),
    source: stale ? CacheSource.cache : CacheSource.network,
  );
}

Material _material() {
  return Material.fromJson({
    'id': 'material-1',
    'school_id': 'school-1',
    'class_id': 'class-1',
    'uploaded_by_user_id': 'teacher-1',
    'last_edited_by_user_id': 'teacher-1',
    'title': 'Study Guide',
    'description': null,
    'storage_key': 'permanent/school-1/materials/material-1.pdf',
    'original_file_name': 'material-1.pdf',
    'mime_type': 'application/pdf',
    'size_bytes': 204800,
    'checksum_sha256': null,
    'ai_visible': false,
    'ingest_status': 'ready',
    'ingest_error': null,
    'ingested_at': null,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

/// Takes the already-built [scope] rather than a raw overrides list — riverpod 3.3.2's
/// `flutter_riverpod.dart` barrel doesn't export the `Override` type its own
/// `ProviderScope.overrides` is typed with, so a test helper can't name `List<Override>` itself
/// (same reasoning as `today_screen_test.dart`).
Future<void> _pumpExamsScreen(WidgetTester tester, ProviderScope scope) async {
  await tester.pumpWidget(wrapWithLocalization(scope));
}

Widget _examsScreenScope() {
  return Builder(
    builder: (context) {
      return MaterialApp(
        theme: AppTheme.light,
        debugShowCheckedModeBanner: false,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        home: const StudentExamsScreen(),
      );
    },
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('shows the skeleton while the agenda is still loading', (tester) async {
    await _pumpExamsScreen(
      tester,
      ProviderScope(
        overrides: [
          examsAgendaProvider.overrideWith((ref) => const AsyncLoading<ExamsAgendaStatus>()),
        ],
        child: _examsScreenScope(),
      ),
    );
    await tester.pump();

    expect(find.byType(ExamsSkeleton), findsOneWidget);
  });

  testWidgets('shows the unavailable message when the student context is unresolved', (
    tester,
  ) async {
    await _pumpExamsScreen(
      tester,
      ProviderScope(
        overrides: [
          examsAgendaProvider.overrideWith(
            (ref) => const AsyncData<ExamsAgendaStatus>(ExamsAgendaUnavailable()),
          ),
        ],
        child: _examsScreenScope(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("Your exams aren't available yet."), findsOneWidget);
  });

  testWidgets('renders a section per day with each exam, its weight and room', (tester) async {
    await _pumpExamsScreen(
      tester,
      ProviderScope(
        overrides: [
          examsAgendaProvider.overrideWith(
            (ref) => AsyncData<ExamsAgendaStatus>(ExamsAgendaReady(_agenda(stale: false))),
          ),
          examRoomDirectoryProvider.overrideWith((ref) async => {'room-1': '204'}),
          materialsClassCodeProvider('class-1').overrideWith((ref) async => 'MATH101-A'),
        ],
        child: _examsScreenScope(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(ExamDaySection), findsNWidgets(2));
    expect(find.byType(ExamCard), findsNWidgets(2));
    expect(find.text('Algebra Midterm'), findsOneWidget);
    expect(find.text('Biology Quiz'), findsOneWidget);
    expect(find.textContaining('Weight 20'), findsNWidgets(2));
    expect(find.textContaining('Room 204'), findsOneWidget);
    expect(find.byType(StalenessBanner), findsNothing);
  });

  testWidgets('the empty state shows its message and hint', (tester) async {
    final empty = CachedValue(
      data: const ExamsAgenda(days: []),
      fetchedAt: DateTime(2026, 9, 1, 8),
      source: CacheSource.network,
    );
    await _pumpExamsScreen(
      tester,
      ProviderScope(
        overrides: [
          examsAgendaProvider.overrideWith(
            (ref) => AsyncData<ExamsAgendaStatus>(ExamsAgendaReady(empty)),
          ),
        ],
        child: _examsScreenScope(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('No upcoming exams.'), findsOneWidget);
    expect(find.text("You're all caught up."), findsOneWidget);
  });

  testWidgets('a cached agenda shows the staleness banner', (tester) async {
    await _pumpExamsScreen(
      tester,
      ProviderScope(
        overrides: [
          examsAgendaProvider.overrideWith(
            (ref) => AsyncData<ExamsAgendaStatus>(ExamsAgendaReady(_agenda(stale: true))),
          ),
          materialsClassCodeProvider('class-1').overrideWith((ref) async => 'MATH101-A'),
        ],
        child: _examsScreenScope(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(StalenessBanner), findsOneWidget);
  });

  testWidgets('the study-materials link opens the materials screen for that class', (
    tester,
  ) async {
    await _pumpExamsScreen(
      tester,
      ProviderScope(
        overrides: [
          examsAgendaProvider.overrideWith(
            (ref) => AsyncData<ExamsAgendaStatus>(ExamsAgendaReady(_agenda(stale: false))),
          ),
          examRoomDirectoryProvider.overrideWith((ref) async => const <String, String>{}),
          materialsClassCodeProvider('class-1').overrideWith((ref) async => 'MATH101-A'),
          materialsForClassProvider('class-1').overrideWith(
            (ref) => Stream.value(
              CachedValue(
                data: [_material()],
                fetchedAt: DateTime(2026, 9, 1, 8),
                source: CacheSource.network,
              ),
            ),
          ),
          materialDownloadedProvider('material-1').overrideWith((ref) async => false),
        ],
        child: _examsScreenScope(),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Study materials').first);
    await tester.pumpAndSettle();

    expect(find.byType(MaterialsScreen), findsOneWidget);
    expect(find.text('Study Guide'), findsOneWidget);
  });
}
