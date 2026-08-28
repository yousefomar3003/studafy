import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/exam.dart';
import '../../../core/api/generated/models/status11.dart';
import '../../../core/api/generated/models/timetable_slot.dart';
import '../../../core/api/generated/models/timetable_version.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/offline/cached_value.dart';
import '../../../core/offline/offline_providers.dart';
import '../domain/timetable_week.dart';
import 'current_term_provider.dart';
import 'student_context_providers.dart';

/// The local midnight of the Monday of [date]'s ISO week (Monday = 1 … Sunday = 7).
DateTime mondayOfWeek(DateTime date) {
  final midnight = DateTime(date.year, date.month, date.day);
  return midnight.subtract(Duration(days: midnight.weekday - 1));
}

/// Which week the timetable screen is showing, as its Monday. Paging is by whole weeks; the
/// recurring slot grid is identical every week, so paging only changes the dates in the header
/// and which exams overlay (see [timetableWeekProvider]).
class VisibleWeekNotifier extends Notifier<DateTime> {
  @override
  DateTime build() => mondayOfWeek(DateTime.now());

  void nextWeek() => state = state.add(const Duration(days: 7));

  void previousWeek() => state = state.subtract(const Duration(days: 7));

  void thisWeek() => state = mondayOfWeek(DateTime.now());
}

final visibleWeekProvider = NotifierProvider<VisibleWeekNotifier, DateTime>(
  VisibleWeekNotifier.new,
);

/// The current term's approved timetable version, or null when the school has none yet. Only one
/// version per term is ever `approved` (the approval workflow supersedes the previous one), so
/// `limit: 1` is exact, not a truncation.
final approvedTimetableVersionProvider = FutureProvider.autoDispose<TimetableVersion?>((ref) async {
  final term = await ref.watch(currentTermProvider.future);
  final api = ref.watch(apiClientProvider);
  final versions = await api.timetable.listTimetableVersions(
    termId: term.id,
    status: Status11.approved,
    limit: 1,
  );
  return versions.timetableVersions.isEmpty ? null : versions.timetableVersions.first;
});

/// Offline-cached slots for one timetable version — every class's slots, not just the student's;
/// [assembleTimetableWeek] narrows to the enrolled set. Keyed by version id so a re-approval
/// (new version) is a fresh cache entry rather than a stale overwrite.
final timetableSlotsProvider = StreamProvider.autoDispose
    .family<CachedValue<List<TimetableSlot>>, String>((ref, versionId) {
      return ref.watch(timetableOfflineRepositoryProvider).slotsForVersion(versionId);
    });

/// Offline-cached exams for the student's enrolled classes, for the exam overlay. Empty (and
/// never fetched) when the enrolment set is unresolved — the screen is [TimetableWeekUnavailable]
/// in that case anyway.
final weekExamsProvider = StreamProvider.autoDispose<CachedValue<List<Exam>>>((ref) {
  final classIds = ref.watch(currentEnrolledClassIdsProvider);
  if (classIds.isEmpty) {
    return Stream.value(
      CachedValue(
        data: const <Exam>[],
        fetchedAt: DateTime.now().toUtc(),
        source: CacheSource.network,
      ),
    );
  }
  return ref.watch(examsOfflineRepositoryProvider).examsForClasses(classIds);
});

/// Resolution seam for a timetable slot's teacher display name. `GET /api/teachers/{id}` is
/// WEB-channel-only and gated on `TEACHER_READ`, neither of which a student session on mobile
/// has, and the linked user's name needs `USER_READ` on top — so there is no path from a
/// `teacher_id` to a name from here today. Resolves to null (the slot row simply omits the
/// teacher line); override once a student-facing resolver exists, the same seam shape as
/// `currentStudentIdProvider` (`student_context_providers.dart`).
final timetableTeacherNameProvider = Provider.autoDispose.family<String?, String>(
  (ref, teacherId) => null,
);

/// The visible week, assembled from the approved version's slots and the enrolled classes' exams,
/// with per-week staleness folded in.
///
/// A plain [Provider] of [AsyncValue] rather than a [StreamProvider] like the today-screen
/// providers: those each have exactly one data source, whereas this one combines two independent
/// offline streams ([timetableSlotsProvider], [weekExamsProvider]) plus [visibleWeekProvider].
/// `ref.watch`-ing both async values and merging them by hand is simpler and more testable than
/// zipping two streams inside a generator.
final timetableWeekProvider = Provider.autoDispose<AsyncValue<TimetableWeekStatus>>((ref) {
  final classIds = ref.watch(currentEnrolledClassIdsProvider);
  if (classIds.isEmpty) {
    return const AsyncData<TimetableWeekStatus>(TimetableWeekUnavailable());
  }

  final versionAsync = ref.watch(approvedTimetableVersionProvider);
  return versionAsync.when(
    loading: () => const AsyncLoading<TimetableWeekStatus>(),
    error: (error, stackTrace) => AsyncError<TimetableWeekStatus>(error, stackTrace),
    data: (version) {
      if (version == null) {
        return const AsyncData<TimetableWeekStatus>(TimetableWeekUnavailable());
      }

      final slotsAsync = ref.watch(timetableSlotsProvider(version.id));
      final examsAsync = ref.watch(weekExamsProvider);

      if (slotsAsync.hasError) {
        return AsyncError<TimetableWeekStatus>(slotsAsync.error!, slotsAsync.stackTrace!);
      }
      if (examsAsync.hasError) {
        return AsyncError<TimetableWeekStatus>(examsAsync.error!, examsAsync.stackTrace!);
      }

      final slots = slotsAsync.value;
      final exams = examsAsync.value;
      if (slots == null || exams == null) {
        return const AsyncLoading<TimetableWeekStatus>();
      }

      final weekStart = ref.watch(visibleWeekProvider);
      final week = assembleTimetableWeek(
        weekStart: weekStart,
        slots: slots.data,
        exams: exams.data,
        enrolledClassIds: classIds.toSet(),
      );

      final fetchedAt = slots.fetchedAt.isBefore(exams.fetchedAt)
          ? slots.fetchedAt
          : exams.fetchedAt;
      final source = slots.isStale || exams.isStale ? CacheSource.cache : CacheSource.network;

      return AsyncData<TimetableWeekStatus>(
        TimetableWeekReady(CachedValue(data: week, fetchedAt: fetchedAt, source: source)),
      );
    },
  );
});
