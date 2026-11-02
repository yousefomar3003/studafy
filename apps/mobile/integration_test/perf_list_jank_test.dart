import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/enrollment_status.dart';
import 'package:studafy_mobile/src/features/teacher/application/teacher_providers.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/teacher_class_detail_screen.dart';

import '../test/support/ensure_date_formatting.dart';
import '../test/support/wrap_with_localization.dart';

/// Perf-pass jank harness (docs/perf-test-protocol.md): scrolls a 60-student class roster and
/// asserts the 60fps frame budget holds, viz. `IntegrationTestWidgetsFlutterBinding.watchPerformance`
/// (`FrameTiming`), the engine's authoritative per-frame build/raster timings.
///
/// This targets the old hot spot — `teacher_class_detail_screen.dart` used to build the entire
/// roster eagerly into a `Column` inside a `ListView` (every tile rebuilt on each tab switch); it
/// is now a `SliverList.builder`, and this test guards against regressing that.
///
/// Frame times from `FrameTiming` are only meaningful in AOT profile/release builds. This file
/// also needs the VM service for `watchPerformance`'s GC accounting, which `flutter drive`
/// provides:
///
///   flutter drive --profile \
///     --driver=test_driver/integration_test_driver.dart \
///     --target=integration_test/perf_list_jank_test.dart
///
/// Run via plain `flutter test integration_test/...` (debug), it still exercises the lazy roster
/// end to end but skips the timing assertion and GC instrumentation — see the protocol doc for the
/// full measurement method (reference device spec, cold start, manual DevTools profiling).
const _rosterSize = 60;
const _frameBudgetMs = 16.7;
const _scrollPasses = 8;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('scrolling a 60-student roster stays inside the frame budget', (tester) async {
    final binding = tester.binding as IntegrationTestWidgetsFlutterBinding;
    await ensureDateFormattingInitialized();
    await EasyLocalization.ensureInitialized();

    final enrollments = List<Enrollment>.generate(
      _rosterSize,
      (i) => Enrollment(
        schoolId: 'school-1',
        classId: 'class-1',
        studentId: 'student-$i',
        status: EnrollmentStatus.active,
        enrolledAt: DateTime(2026, 1, 1),
        withdrawnAt: null,
        createdAt: DateTime(2026, 1, 1),
        updatedAt: DateTime(2026, 1, 1),
      ),
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          classRosterProvider.overrideWith((ref, classId) async => enrollments),
          classCourseNameProvider.overrideWith((ref, classId) async => 'Algebra I'),
        ],
        child: wrapWithLocalization(
          MaterialApp(
            home: const TeacherClassDetailScreen(classId: 'class-1', classCode: 'MA-101'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byType(CustomScrollView),
      findsOneWidget,
      reason: 'roster should be lazily rendered by a sliver list, not an eager ListView/Column',
    );

    Future<void> scrollRoster() async {
      for (var pass = 0; pass < _scrollPasses; pass++) {
        await tester.fling(find.byType(CustomScrollView), const Offset(0, -800), 3000);
        await tester.pumpAndSettle();
      }
    }

    if (kProfileMode || kReleaseMode) {
      await binding.watchPerformance(scrollRoster, reportKey: 'roster_scroll');
      final summary = binding.reportData!['roster_scroll']! as Map<String, dynamic>;
      _assertWithinBudget(summary);
    } else {
      await scrollRoster();
      debugPrint(
        'perf_list_jank_test: debug harness run — frame numbers are only meaningful via '
        '`flutter drive --profile`',
      );
    }
  });
}

void _assertWithinBudget(Map<String, dynamic> summary) {
  final frameCount = summary['frame_count']! as int;
  final avgBuildMs = summary['average_frame_build_time_millis']! as double;
  final avgRasterMs = summary['average_frame_rasterizer_time_millis']! as double;
  final p90TotalMs =
      (summary['90th_percentile_frame_build_time_millis']! as double) +
      (summary['90th_percentile_frame_rasterizer_time_millis']! as double);
  final missedFrames =
      (summary['missed_frame_build_budget_count']! as int) +
      (summary['missed_frame_rasterizer_budget_count']! as int);

  debugPrint(
    'perf_list_jank_test: $frameCount frames, avg build+raster '
    '${(avgBuildMs + avgRasterMs).toStringAsFixed(2)} ms, p90 total '
    '${p90TotalMs.toStringAsFixed(2)} ms, $missedFrames missed budget(s), '
    'worst build ${summary['worst_frame_build_time_millis']!.toStringAsFixed(2)} ms, '
    'worst raster ${summary['worst_frame_rasterizer_time_millis']!.toStringAsFixed(2)} ms',
  );

  expect(frameCount, greaterThan(0), reason: 'no frames captured during the scroll');
  expect(
    avgBuildMs + avgRasterMs < _frameBudgetMs && p90TotalMs < _frameBudgetMs,
    isTrue,
    reason: 'average and p90 frame time (build + raster) must stay under the '
        '$_frameBudgetMs ms 60fps budget',
  );
}