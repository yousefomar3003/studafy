import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/published_grade_snapshot.dart';
import '../../../core/api/generated/models/term.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/offline/cached_value.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/realtime/realtime_providers.dart';
import '../domain/grade_report.dart';
import '../domain/grade_trend.dart';
import 'current_term_provider.dart';
import 'student_context_providers.dart';

/// Every term of the current academic year, ascending by [Term.sequenceNumber] — the term
/// picker's options and the trend's x-axis.
///
/// Reuses [currentTermProvider] purely to resolve the active academic year id (it already does
/// that lookup); unlike it, this keeps past and future terms too, since browsing "by term" and
/// plotting a trend both need them. Surfaces as [AsyncError] on the same misconfiguration
/// [currentTermProvider] throws for (a school with no active year/term).
final academicYearTermsProvider = FutureProvider<List<Term>>((ref) async {
  final currentTerm = await ref.watch(currentTermProvider.future);
  final api = ref.watch(apiClientProvider);
  final page = await api.academics.listTerms(yearId: currentTerm.academicYearId, limit: 50);
  return page.terms.toList()
    ..sort((a, b) => a.sequenceNumber.compareTo(b.sequenceNumber));
});

/// Which term the grades screen is showing. Null means "follow the default" —
/// [defaultGradeTerm] resolves it to the active term (or the latest) against the live term
/// list, so the selection stays sensible even before [academicYearTermsProvider] has loaded.
///
/// App-scoped on purpose: a term the student picked should still be selected if they leave the
/// screen and come back. A push deep link resets it (see `grades_screen.dart`) so it always
/// lands on the term the grade was published in.
class SelectedGradeTermNotifier extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String termId) => state = termId;

  void reset() => state = null;
}

final selectedGradeTermProvider = NotifierProvider<SelectedGradeTermNotifier, String?>(
  SelectedGradeTermNotifier.new,
);

/// One term's offline-cached published-grades snapshot for the signed-in student.
///
/// Re-fetches live on a `grades.published` realtime event naming this student — the same
/// pattern, and the same rationale, as `today_providers.dart`'s [todayGradesProvider]. Emits
/// nothing while [currentStudentIdProvider] is unresolved; callers treat that as
/// [GradeReportUnavailable] rather than a stuck spinner.
final gradeSnapshotProvider = StreamProvider.autoDispose
    .family<CachedValue<PublishedGradeSnapshot>, String>((ref, termId) {
      final studentId = ref.watch(currentStudentIdProvider);
      if (studentId == null) return const Stream.empty();

      ref.listen(realtimeEventsProvider, (previous, next) {
        final envelope = next.value;
        if (envelope?.type != 'grades.published') return;
        final payload = envelope!.payload;
        if (payload is Map && payload['studentId'] == studentId) {
          ref.invalidateSelf();
        }
      });

      return ref
          .watch(publishedGradesOfflineRepositoryProvider)
          .snapshotFor(studentId: studentId, termId: termId);
    });

/// The selected term's [GradeReport], assembled from the term list and that term's snapshot,
/// with per-term staleness carried through.
///
/// A plain [Provider] of [AsyncValue] rather than a generator, for the same reason
/// `timetable_providers.dart`'s `timetableWeekProvider` is one: it merges three inputs
/// ([academicYearTermsProvider], [selectedGradeTermProvider], [gradeSnapshotProvider]) and
/// `ref.watch`-ing them and combining by hand is simpler and more testable than zipping streams.
final gradeReportProvider = Provider.autoDispose<AsyncValue<GradeReportStatus>>((ref) {
  final studentId = ref.watch(currentStudentIdProvider);
  if (studentId == null) {
    return const AsyncData<GradeReportStatus>(GradeReportUnavailable());
  }

  final termsAsync = ref.watch(academicYearTermsProvider);
  return termsAsync.when(
    loading: () => const AsyncLoading<GradeReportStatus>(),
    error: (error, stackTrace) => AsyncError<GradeReportStatus>(error, stackTrace),
    data: (terms) {
      if (terms.isEmpty) {
        return const AsyncData<GradeReportStatus>(GradeReportUnavailable());
      }

      final term = _resolveSelectedTerm(terms, ref.watch(selectedGradeTermProvider));
      final snapshotAsync = ref.watch(gradeSnapshotProvider(term.id));

      return snapshotAsync.when(
        loading: () => const AsyncLoading<GradeReportStatus>(),
        error: (error, stackTrace) => AsyncError<GradeReportStatus>(error, stackTrace),
        data: (cached) => AsyncData<GradeReportStatus>(
          GradeReportReady(
            CachedValue(
              data: assembleGradeReport(term: term, snapshot: cached.data),
              fetchedAt: cached.fetchedAt,
              source: cached.source,
            ),
          ),
        ),
      );
    },
  );
});

/// The trend sparkline's points, one per term of the year that has a resolvable snapshot.
///
/// Fans out one [gradeSnapshotProvider] per term (all offline-cached, so a term viewed before
/// still plots with no connectivity). Terms still loading are simply omitted — the sparkline
/// fills in as their snapshots arrive rather than blocking the screen on all of them.
final gradeTrendProvider = Provider.autoDispose<List<GradeTrendPoint>>((ref) {
  final terms = ref.watch(academicYearTermsProvider).valueOrNull;
  if (terms == null) return const [];

  final points = <GradeTrendPoint>[];
  for (final term in terms) {
    final snapshot = ref.watch(gradeSnapshotProvider(term.id)).valueOrNull;
    if (snapshot == null) continue;
    final summary = snapshot.data.termSummary;
    points.add(
      GradeTrendPoint(
        termId: term.id,
        termName: term.name,
        termSequenceNumber: term.sequenceNumber,
        termAveragePercentage: summary.termAveragePercentage?.toDouble(),
        termGpa: summary.termGpa?.toDouble(),
      ),
    );
  }
  return points;
});

/// Which term a `GRADE_POSTED` push deep link (`/courses/{courseId}/grades`) should open.
///
/// The push payload only carries a course id, so this finds the newest term of the year whose
/// snapshot already contains a published grade for that course — reusing the snapshots
/// [gradeTrendProvider] fetches anyway, so it needs no extra endpoint or permission. Null while
/// those are still loading, or when no fetched term has the course; the screen falls back to
/// the default term (the active one — which is where a freshly published grade lives in every
/// realistic case) until this resolves.
final deepLinkGradeTermProvider = Provider.autoDispose.family<String?, String>((ref, courseId) {
  final terms = ref.watch(academicYearTermsProvider).valueOrNull;
  if (terms == null) return null;

  for (final term in terms.reversed) {
    final snapshot = ref.watch(gradeSnapshotProvider(term.id)).valueOrNull;
    if (snapshot == null) continue;
    final hasCourse = snapshot.data.grades.any((grade) => grade.course.id == courseId);
    if (hasCourse) return term.id;
  }
  return null;
});

Term _resolveSelectedTerm(List<Term> terms, String? selectedId) {
  if (selectedId != null) {
    for (final term in terms) {
      if (term.id == selectedId) return term;
    }
  }
  return defaultGradeTerm(terms);
}
