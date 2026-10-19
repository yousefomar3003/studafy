import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/status11.dart';
import '../../../core/api/generated/models/timetable_settings.dart';
import '../../../core/api/generated/models/timetable_slot.dart';
import '../../../core/api/generated/models/timetable_version.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/offline/cached_value.dart';
import '../../../core/offline/offline_providers.dart';
import '../../../core/realtime/realtime_providers.dart';
import '../../student/application/current_term_provider.dart';
import '../../student/application/student_context_providers.dart';
import '../../teacher/application/teacher_providers.dart';
import '../domain/weekly_schedule.dart';

/// The domain event the API emits when a timetable version goes live (approve, or one-step
/// publish) — `DOMAIN_EVENTS.TIMETABLE_APPROVED` in `packages/constants/src/events.ts`.
const timetableApprovedEvent = 'timetable.approved';

/// The current term's approved timetable version, or null when the school has none yet. Only one
/// version per term is ever `approved` (the approval workflow supersedes the previous one), so
/// `limit: 1` is exact, not a truncation.
///
/// Re-resolves on a [timetableApprovedEvent] so a newly approved version replaces the old one
/// while the schedule is open. Note the realtime gateway (`apps/realtime/src/event-routing.ts`)
/// does not route that event to clients today, so in practice the refresh comes from re-opening
/// the Timetable tab or pulling to refresh (see [refreshWeeklySchedule]); this listener is what
/// makes it live once a route is added.
final approvedTimetableVersionProvider = FutureProvider.autoDispose<TimetableVersion?>((ref) async {
  ref.listen(realtimeEventsProvider, (previous, next) {
    if (next.value?.type == timetableApprovedEvent) ref.invalidateSelf();
  });

  final term = await ref.watch(currentTermProvider.future);
  final api = ref.watch(apiClientProvider);
  final versions = await api.timetable.listTimetableVersions(
    termId: term.id,
    status: Status11.approved,
    limit: 1,
  );
  return versions.timetableVersions.isEmpty ? null : versions.timetableVersions.first;
});

/// Offline-cached slots for one timetable version — every class's slots; the schedule providers
/// below narrow them per viewer. Keyed by version id so a re-approval (new version) is a fresh
/// cache entry rather than a stale overwrite.
///
/// A first build serves the cache first; a refresh ([refreshWeeklySchedule]) goes network-first,
/// keeping the schedule already on screen until the server answers instead of flashing the
/// cached copy (and its staleness banner) in between.
final timetableSlotsProvider = StreamProvider.autoDispose
    .family<CachedValue<List<TimetableSlot>>, String>((ref, versionId) {
      return ref
          .watch(timetableOfflineRepositoryProvider)
          .slotsForVersion(versionId, cacheFirst: !ref.isRefresh);
    });

/// The school's teaching week, offline-cached the same way as [timetableSlotsProvider].
final timetableSettingsProvider = StreamProvider.autoDispose<CachedValue<TimetableSettings>>((ref) {
  return ref.watch(timetableOfflineRepositoryProvider).settings(cacheFirst: !ref.isRefresh);
});

/// Resolution seam for a timetable slot's teacher display name. `GET /api/teachers/{id}` is
/// WEB-channel-only and gated on `TEACHER_READ`, neither of which a student session on mobile
/// has, and the linked user's name needs `USER_READ` on top — so there is no path from a
/// `teacher_id` to a name from here today. Resolves to null (the lesson card simply omits the
/// teacher); override once a student-facing resolver exists, the same seam shape as
/// `currentStudentIdProvider` (`student_context_providers.dart`).
final timetableTeacherNameProvider = Provider.autoDispose.family<String?, String>(
  (ref, teacherId) => null,
);

/// Re-syncs everything a weekly schedule is built from — settings, approved version, slots — so
/// an admin's edit shows. Called when the Timetable tab is brought back into view and on
/// pull-to-refresh; completes once the approved version has re-resolved.
Future<void> refreshWeeklySchedule(WidgetRef ref) async {
  ref
    ..invalidate(timetableSettingsProvider)
    ..invalidate(approvedTimetableVersionProvider)
    ..invalidate(timetableSlotsProvider);
  try {
    await ref.read(approvedTimetableVersionProvider.future);
  } on Object {
    // Surfaced by the schedule provider itself; the refresh gesture only needs to finish.
  }
}

/// The signed-in student's weekly schedule: the approved version's slots for the classes they
/// are enrolled in.
final studentWeeklyScheduleProvider = Provider.autoDispose<AsyncValue<WeeklyScheduleStatus>>((ref) {
  // Stay in loading (rather than flash "unavailable") while /api/students/me resolves.
  if (ref.watch(currentStudentSelfProvider).isLoading) {
    return const AsyncLoading<WeeklyScheduleStatus>();
  }
  final classIds = ref.watch(currentEnrolledClassIdsProvider).toSet();
  if (classIds.isEmpty) {
    return const AsyncData<WeeklyScheduleStatus>(WeeklyScheduleUnavailable());
  }
  return _assembleWeeklySchedule(ref, (slots) => slotsForClasses(slots, classIds));
});

/// The signed-in teacher's weekly schedule: every approved slot they teach, whichever class it
/// belongs to (a teacher can cover classes they do not lead).
final teacherWeeklyScheduleProvider = Provider.autoDispose<AsyncValue<WeeklyScheduleStatus>>((ref) {
  final teacherId = ref.watch(teacherIdProvider);
  if (teacherId.hasError && !teacherId.hasValue) {
    return AsyncError<WeeklyScheduleStatus>(teacherId.error!, teacherId.stackTrace!);
  }
  final id = teacherId.value;
  if (id == null) return const AsyncLoading<WeeklyScheduleStatus>();
  return _assembleWeeklySchedule(ref, (slots) => slotsForTeacher(slots, id));
});

/// Combines the approved version, its (filtered) slots and the school week into one status.
///
/// Reads `.value` rather than `when`, so a refresh in flight keeps the previous schedule on
/// screen. The settings are best-effort: if they can't be loaded (and nothing is cached), the
/// schedule falls back to the API's default week rather than failing the whole screen.
AsyncValue<WeeklyScheduleStatus> _assembleWeeklySchedule(
  Ref ref,
  List<TimetableSlot> Function(List<TimetableSlot> slots) select,
) {
  final versionAsync = ref.watch(approvedTimetableVersionProvider);
  if (!versionAsync.hasValue) {
    return versionAsync.hasError
        ? AsyncError<WeeklyScheduleStatus>(versionAsync.error!, versionAsync.stackTrace!)
        : const AsyncLoading<WeeklyScheduleStatus>();
  }
  final version = versionAsync.value;
  if (version == null) {
    return const AsyncData<WeeklyScheduleStatus>(WeeklyScheduleUnavailable());
  }

  final slotsAsync = ref.watch(timetableSlotsProvider(version.id));
  final settingsAsync = ref.watch(timetableSettingsProvider);

  final slots = slotsAsync.value;
  if (slots == null) {
    return slotsAsync.hasError
        ? AsyncError<WeeklyScheduleStatus>(slotsAsync.error!, slotsAsync.stackTrace!)
        : const AsyncLoading<WeeklyScheduleStatus>();
  }
  final settings = settingsAsync.value;
  if (settings == null && !settingsAsync.hasError) {
    return const AsyncLoading<WeeklyScheduleStatus>();
  }

  final schedule = buildWeeklySchedule(
    schoolDays: settings?.data.schoolDays,
    slots: select(slots.data),
  );

  final stale = slots.isStale || (settings?.isStale ?? false);
  final fetchedAt = settings != null && settings.fetchedAt.isBefore(slots.fetchedAt)
      ? settings.fetchedAt
      : slots.fetchedAt;

  return AsyncData<WeeklyScheduleStatus>(
    WeeklyScheduleReady(
      CachedValue(
        data: schedule,
        fetchedAt: fetchedAt,
        source: stale ? CacheSource.cache : CacheSource.network,
      ),
    ),
  );
}
